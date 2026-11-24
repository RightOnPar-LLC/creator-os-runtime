// Test harness: boots the runtime against a throwaway Postgres (PGlite over the
// Postgres wire protocol), on 127.0.0.1 only, with every outbound fetch blocked.
//
// The runtime under test is chosen by ENTRY below (or RUNTIME_ENTRY in the env,
// resolved relative to this folder). That is the only line that changes between
// testing src/runtime.js (the unsplit original), src/index.js and dist/runtime.js.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHash, createHmac } from "node:crypto";
import net from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY = "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const entryPath = resolve(here, process.env.RUNTIME_ENTRY || ENTRY);

// ---- secrets: test values only -------------------------------------------------
export const ADMIN_KEY = "test-admin-key-0123456789";
export const VAULT_KEY = "a".repeat(64);
export const MESH_SECRET = "test-mesh-secret";
export const GITHUB_SECRET = "test-github-secret";
export const RAILWAY_TOKEN = "test-railway-webhook-token";
export const BRAIN_SECRET = "test-brain-secret";
export const RATE_LIMIT = 40;

// ---- 1. throwaway Postgres -------------------------------------------------------
const pg = await PGlite.create();
// idleTimeout: a connection that sends nothing for 10 s is dropped and, if it was inside a transaction,
// rolled back. Without it a run could hang for good: when this machine loses a connection's FIN (2a),
// the server still holds that handler, the runtime's client re-dials, and pglite-socket parks every
// query of the new connection behind the old one's open transaction. Seen as every remaining test
// timing out, 30 s each. With it, the stuck handler is reaped after 10 s and the run goes on, minus the
// one query that was waiting (its connection idles out at the same moment; that test fails with a 500).
// Healthy runs never leave the database idle for 10 s: the longest gap is the 2.5 s "slow lsp" test.
const pgServer = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1", maxConnections: 8, idleTimeout: 10000 });
/** Direct SQL against the throwaway DB, for tests that must set up a state no route can reach. */
export const dbQuery = (q, params = []) => pg.query(q, params);
await pgServer.start();
const DATABASE_URL = `postgres://postgres:postgres@${pgServer.getServerConn()}/postgres`;

// ---- 2. outbound network: blocked ----------------------------------------------
const realFetch = globalThis.fetch;
export const blockedFetches = [];
let port = 0;
let lspPort = 0;
let payrailPort = 0;
let meshmarketPort = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "127.0.0.1" && (Number(url.port) === port || Number(url.port) === lspPort || Number(url.port) === payrailPort || Number(url.port) === meshmarketPort)) return localFetch(input, init);
  blockedFetches.push(url.href);
  throw new TypeError(`blocked by test harness: ${url.href}`);
};

// ---- 2a. this machine's loopback: a refused connection is asked again ---------------
// Every listener the harness talks to is up, in this process, for the whole run. So a REFUSED
// connection to one of them says nothing about the runtime: the machine dropped it. Seen for real
// (Windows, 2026-10-09; how to check a machine: loopback-check.mjs): connections to 127.0.0.1 whose
// own (client) port fell in certain stretches of port numbers were dropped. The OS hands client ports
// out in rising order, so everything on the box failed together until that shared pointer had moved
// past the stretch. bun says ConnectionRefused when the socket died before bun wrote the request (a
// closed port, or a peer that hung up on the handshake), so the runtime never saw that request and
// asking again cannot repeat it. A request that was written and then lost (ECONNRESET, a timeout)
// is never asked again: the runtime may have acted on it.
const loopback = { refused: 0, bootRefused: 0, bootWaitMs: 0, reset: 0, lastAt: 0, step: 16 };
const REFUSED = new Set(["ConnectionRefused", "ECONNREFUSED"]);
/**
 * After a refusal: count it, and move the OS's port pointer on (a listener on port 0 takes the next free
 * port and gives it back). 16 ports the first time, twice as many each time refusals keep coming, so a
 * stretch of any width is left behind after a few of them.
 */
const stepPastRefusal = async () => {
  loopback.refused++;
  loopback.step = Date.now() - loopback.lastAt < 5000 ? Math.min(loopback.step * 2, 1024) : 16;
  loopback.lastAt = Date.now();
  for (let i = 0; i < loopback.step; i++)
    await new Promise((done) => {
      const s = net.createServer();
      s.once("error", done);
      s.listen(0, "127.0.0.1", () => s.close(done));
    });
};
/** fetch to one of the harness's own listeners. Gives up after 20 s of refusals with the last one. */
async function localFetch(input, init) {
  for (const t0 = Date.now(); ; ) {
    try {
      return await realFetch(input, init);
    } catch (e) {
      if (e?.code === "ECONNRESET") loopback.reset++; // counted, never asked again
      // a Request object's body may already be spent, so only a plain url is asked again
      if (!REFUSED.has(e?.code) || typeof input !== "string" || Date.now() - t0 > 20000) throw e;
      await stepPastRefusal();
    }
  }
}

// ---- 2b. a fake lsp-mcp (0.3.2) --------------------------------------------------
// Behaves like the real one at the seam the runtime depends on: it introspects the
// presented grant against THIS runtime (GET /api/grants/verify), refuses without
// lsp.diagnose, and returns diagnostics bound to the overlay hash. Content that
// contains "BROKEN" gets an error, "WARN" a warning. `lsp.mode` flips failure modes.
export const lsp = { mode: "ok", calls: [] };
/** The overlay canon (mirrors src/policy.js overlayHash and lsp-mcp's, length-prefixed). */
export const overlayHash = (files) => {
  const h = createHash("sha256");
  h.update("overlay/v2\n");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1)))
    h.update(`${Buffer.byteLength(f.path, "utf8")}:`).update(f.path).update(`\n${Buffer.byteLength(f.content, "utf8")}:`).update(f.content).update("\n");
  return h.digest("hex");
};
const lspServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(r) {
    const u = new URL(r.url);
    if (u.pathname === "/health") return Response.json({ ok: true, service: "lsp-mcp", fake: true });
    if (u.pathname !== "/mcp" || r.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    if (lsp.mode === "down") return new Response("bad gateway", { status: 502 });
    const body = await r.json();
    const token = (r.headers.get("authorization") || "").replace(/^Bearer /, "");
    const rpcErr = (status, message, data = null) => Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32001, message, data } }, { status });
    if (!token) return rpcErr(403, "missing_grant");
    const v = await localFetch(`${BASE}/api/grants/verify`, { headers: { authorization: `Bearer ${token}` } });
    if (v.status !== 200) return rpcErr(403, (await v.json()).error || "bad_grant");
    const caps = (await v.json()).caps || [];
    if (!caps.includes("lsp.diagnose")) return rpcErr(403, "missing_cap", { need: "lsp.diagnose" });
    if (lsp.mode === "broke") return rpcErr(402, "budget_exhausted");
    if (lsp.mode === "slow") await new Promise((r) => setTimeout(r, 2500));
    const files = body.params?.arguments?.files || [];
    // Charge the call exactly as the real gate does (verify, then settle with the same token).
    const st = await localFetch(`${BASE}/api/grants/settle`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ calls: 1, usd_cents: 0, deploys: 0, ref: "lsp:diagnose", note: `lsp.diagnose ${files.length} file(s)` }),
    });
    if (st.status === 402) return rpcErr(402, "budget_exhausted");
    if (st.status !== 200) return rpcErr(403, (await st.json()).error || "settle_failed");
    lsp.calls.push({ token, files: files.map((f) => f.path) });
    const out = files.map((f) => ({
      path: f.path,
      diagnostics: [
        ...(f.content.includes("BROKEN") ? [{ severity: "error", message: "Type 'number' is not assignable to type 'string'.\nsecond line", line: 1, col: 4, code: 2322, source: "typescript" }] : []),
        ...(f.content.includes("WARN") ? [{ severity: "warning", message: "'x' is declared but never used.", line: 0, col: 0, code: 6133, source: "typescript" }] : []),
      ],
    }));
    const summary = { errors: 0, warnings: 0, informations: 0, hints: 0 };
    for (const f of out) for (const d of f.diagnostics) summary[d.severity + "s"]++;
    const result = { backend: "typescript", filesSha256: overlayHash(files), files: out, summary, warnings: [], durationMs: 1 };
    return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
  },
});
lspPort = lspServer.port;
export const LSP_URL = `http://127.0.0.1:${lspPort}`;

// ---- 2c. a fake PayRail (x402, Base Sepolia staging) --------------------------------
// Answers GET /pay/x402 the way the real PayRail does: no signature -> 402 with
// the payment-required header; with one -> 200 settled (or the mode's failure).
// Also answers JSON-RPC eth_getTransactionReceipt for reconcile. The test sets
// payrail.offer before starting a job (the order the fake will offer), flips
// payrail.mode for failure paths, and reads payrail.seen to prove exactly-once
// submission. Mirrors the fake lsp-mcp above: same shape, same rules.
export const PAYRAIL_NETWORK = "eip155:84532";
export const PAYRAIL_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PAYRAIL_RECIPIENT = "0x1111111111111111111111111111111111111111";
export const PAYRAIL_FEE_PAYER = "0x2222222222222222222222222222222222222222";
export const PAYRAIL_TX = "0x" + "ab".repeat(32);
export const payrail = {
  mode: "ok", // ok | invalid | drop (settle, then lose the response)
  offer: null, // { orderId, amountUsdCents } — the one order the fake will offer
  seen: [], // every signed /pay/x402 call: { orderId, signature }
  settledTx: null, // the tx the fake settled, once it has
  txReceipt: null, // what eth_getTransactionReceipt returns for settledTx (null = not mined)
};
const payrailRequirement = (offer) => ({
  scheme: "exact",
  network: PAYRAIL_NETWORK,
  amount: String(offer.amountUsdCents * 10000),
  asset: PAYRAIL_ASSET,
  payTo: PAYRAIL_RECIPIENT,
  maxTimeoutSeconds: 60,
  extra: { feePayer: PAYRAIL_FEE_PAYER },
});
const b64u = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const payrailServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(r) {
    const u = new URL(r.url);
    if (u.pathname === "/pay/x402" && r.method === "GET") {
      const orderId = u.searchParams.get("order");
      if (!payrail.offer || payrail.offer.orderId !== orderId) return Response.json({ error: "unknown_order" }, { status: 404 });
      const requirement = payrailRequirement(payrail.offer);
      const signature = r.headers.get("payment-signature");
      if (!signature) {
        const required = { x402Version: 2, error: "payment_required", resource: { url: `${PAYRAIL_URL}/pay/x402?order=${encodeURIComponent(orderId)}`, description: `PayRail order ${orderId}`, mimeType: "application/json" }, accepts: [requirement] };
        return new Response(JSON.stringify({ error: "payment_required", order: orderId, amount_usd: (payrail.offer.amountUsdCents / 100).toFixed(2) }), { status: 402, headers: { "payment-required": b64u(required), "content-type": "application/json" } });
      }
      let payload = null;
      try {
        payload = JSON.parse(Buffer.from(signature, "base64url").toString("utf8"));
      } catch {
        return Response.json({ error: "bad_payment_signature" }, { status: 400 });
      }
      payrail.seen.push({ orderId, signature: payload });
      if (payrail.mode === "invalid") return Response.json({ error: "invalid:authorization_used" }, { status: 402 });
      payrail.settledTx = PAYRAIL_TX;
      // "drop" = the settle response is lost after the tx lands. A real drop is
      // a connection reset; the engine treats any non-200 the same way (the job
      // stays settling for reconcile). The fake answers 502 rather than throwing:
      // a throwing serve handler surfaces as an uncaught exception and aborts
      // the running bun:test test before its assertions run.
      if (payrail.mode === "drop") return Response.json({ error: "settle_response_dropped" }, { status: 502 });
      const response = { success: true, transaction: PAYRAIL_TX, network: PAYRAIL_NETWORK, payer: payload?.payload?.authorization?.from ?? null };
      return new Response(JSON.stringify({ ok: true, id: PAYRAIL_TX, order: orderId, paid_usd: (payrail.offer.amountUsdCents / 100).toFixed(2), unlocked: true }), { status: 200, headers: { "payment-response": b64u(response), "content-type": "application/json" } });
    }
    if (u.pathname === "/" && r.method === "POST") {
      const body = await r.json().catch(() => ({}));
      if (body.method === "eth_getTransactionReceipt") {
        const receipt = body.params?.[0] === payrail.settledTx ? payrail.txReceipt : null;
        return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: receipt });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x0" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});
payrailPort = payrailServer.port;
export const PAYRAIL_URL = `http://127.0.0.1:${payrailPort}`;

// ---- 2c. a fake MeshMarket (market.meshtool.ai) for the MeshMarket rail ------------------
// Behaves like the real exchange on the paths the rail uses (src/index.js there): signup
// returns the key once; /api/call/:slug honours idempotency-key (replays the stored outcome,
// never a second charge) and x-max-price (409 price_above_max, nothing charged); a listing in
// "hold" mode answers held:true with a hold the buyer can read and accept; a provider failure
// is 502 provider_failed with refunded true/false. A test sets meshmarket.mode / .price, flips
// a hold's state, and reads .charges to prove exactly-once.
export const meshmarket = {
  key: null, // the one key signup issued
  credits: 250,
  price: 20,
  mode: "instant", // instant | hold | fail | fail_unrefunded | drop (charge, then lose the answer) | down (503, no body)
  charges: 0, // calls that actually charged (replays excluded)
  calls: [], // every POST /api/call: { slug, idem, max }
  idem: {}, // idempotency key -> { status, body }
  holds: {}, // hold_id -> public hold view
  accepts: 0,
};
let mmSeq = 0;
const meshmarketServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(r) {
    const u = new URL(r.url);
    const authed = () => meshmarket.key && r.headers.get("x-agent-key") === meshmarket.key;
    if (u.pathname === "/api/accounts" && r.method === "POST") {
      const b = await r.json().catch(() => ({}));
      if (!b.handle) return Response.json({ error: "handle_required" }, { status: 400 });
      meshmarket.key = "mk_fake_" + ++mmSeq + "_" + Math.random().toString(36).slice(2);
      return Response.json({ handle: b.handle, api_key: meshmarket.key, credits: meshmarket.credits }, { status: 201 });
    }
    if (!authed()) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (u.pathname === "/api/account" && r.method === "GET") return Response.json({ credits: meshmarket.credits });
    const call = u.pathname.match(/^\/api\/call\/([a-z0-9-]+)$/);
    if (call && r.method === "POST") {
      const slug = call[1], idem = r.headers.get("idempotency-key") || "", max = Number(r.headers.get("x-max-price") || "0");
      meshmarket.calls.push({ slug, idem, max });
      if (meshmarket.mode === "down") return new Response("upstream unavailable", { status: 503 });
      if (idem && meshmarket.idem[idem]) {
        const p = meshmarket.idem[idem];
        return Response.json({ ...p.body, replayed: true }, { status: p.status });
      }
      if (max && meshmarket.price > max) return Response.json({ error: "price_above_max", price: meshmarket.price, max }, { status: 409 });
      const callId = "call_" + ++mmSeq;
      if (meshmarket.mode === "fail" || meshmarket.mode === "fail_unrefunded")
        return Response.json({ error: "provider_failed", refunded: meshmarket.mode === "fail", call_id: callId }, { status: 502 });
      meshmarket.charges++;
      meshmarket.credits -= meshmarket.price;
      let body = { ok: true, capability: slug, charged: meshmarket.price, currency: "MESH", balance: meshmarket.credits, call_id: callId, result: { answer: "fake" } };
      if (meshmarket.mode === "hold" || meshmarket.mode === "drop_hold") {
        const holdId = "hold_" + mmSeq;
        meshmarket.holds[holdId] = { id: holdId, call_id: callId, state: "held", price: meshmarket.price, currency: "MESH", stake: 0, verdict: null, provider_share: null, resolved_at: null };
        body = { ...body, held: true, hold_id: holdId, release_at: "2099-01-01 00:00:00" };
      }
      if (idem) meshmarket.idem[idem] = { status: 200, body };
      // "drop" = the call charged and was recorded, but the answer never reached the runtime.
      if (meshmarket.mode === "drop" || meshmarket.mode === "drop_hold") return new Response("connection reset", { status: 502 });
      return Response.json(body);
    }
    const hold = u.pathname.match(/^\/api\/holds\/([A-Za-z0-9_]+)(\/accept)?$/);
    if (hold) {
      const h = meshmarket.holds[hold[1]];
      if (!h) return Response.json({ error: "not_found" }, { status: 404 });
      if (hold[2] && r.method === "POST") {
        if (h.state !== "held") return Response.json({ error: "illegal_transition", state: h.state }, { status: 409 });
        meshmarket.accepts++;
        h.state = "released";
        h.resolved_at = "2026-11-21 00:00:00";
        return Response.json({ ok: true, state: "released", provider_paid: h.price - Math.floor(h.price * 0.05), take: Math.floor(h.price * 0.05) });
      }
      return Response.json({ ...h, role: "caller" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});
meshmarketPort = meshmarketServer.port;
export const MESHMARKET_URL = `http://127.0.0.1:${meshmarketPort}`;

// ---- 3. listener on 127.0.0.1 (port known before import, for PUBLIC_URL) ---------
let handler = () => new Response("booting", { status: 503 });
// idleTimeout as the runtime sets it for its own listener (src/index.js; section 1 checks the number).
// With bun's default of 10 s this listener hung up on connections production keeps for 255 s.
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: (req) => handler(req) });
port = server.port;
export const BASE = `http://127.0.0.1:${port}`;

// ---- 3a. the database client: one connection, made and proven before the runtime loads ----
// PGlite is ONE Postgres session shared by every socket. Bun.SQL pools connections and names its
// prepared statements per connection, so two pooled connections collide on the shared session
// ("prepared statement ... already exists"). Pin the pool to one connection. This is a
// test-environment shim only: production talks to a real Postgres and constructs Bun.SQL exactly
// as the runtime does.
//
// The runtime opens its connection while it is imported and runs the schema on it at once. A refused
// connect there is an error between tests and the whole run dies ("36 pass, 1 fail"). So the harness
// makes that connection first, asks again while the machine refuses it (see 2a), and the shim hands
// the runtime this proven client. A client whose connect was refused opens a new connection on its
// next query, so once it has answered once nothing more is needed.
const RealSQL = globalThis.Bun.SQL;
const provenSql = new RealSQL(DATABASE_URL, { max: 1 });
globalThis.Bun.SQL = function PinnedSQL(url, opts) {
  if (url === DATABASE_URL && opts === undefined) return provenSql;
  return new RealSQL(url, { ...(opts || {}), max: 1 });
};
const bootStart = Date.now();
for (;;) {
  try {
    await provenSql`SELECT 1`;
    break;
  } catch (e) {
    if (e?.code !== "ERR_POSTGRES_CONNECTION_REFUSED" || Date.now() - bootStart > 120000)
      throw new Error("harness: the throwaway database, listening in this process, could not be reached for two minutes. That is this machine, not the runtime: node test/loopback-check.mjs", { cause: e });
    await stepPastRefusal();
  }
}
loopback.bootWaitMs = Date.now() - bootStart;
loopback.bootRefused = loopback.refused;
if (loopback.bootRefused) console.warn(`harness: this machine refused ${loopback.bootRefused} connection(s) to the throwaway database before boot; it answered after ${loopback.bootWaitMs} ms (node test/loopback-check.mjs)`);

// ---- 4. env, then import --------------------------------------------------------
for (const k of [
  "ANTHROPIC_API_KEY", "RAILWAY_API_TOKEN", "RAILWAY_OAUTH_CLIENT_ID", "RAILWAY_OAUTH_CLIENT_SECRET",
  "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MAP", "COG_BRIDGE_URL", "COG_BRIDGE_TOKEN", "COG_SYNC_TOKEN",
  "BRAIN_URL", "GRANT_SIGNING_KEY", "OAUTH_REDIRECT_HOSTS", "POSTGRES_URL", "PORT", "RUNTIME_MODE", "COG_MODEL",
  "LSP_MCP_URL", "LSP_MCP_TIMEOUT_MS", "REAP_INTERVAL_MS", "BUS_EVENTS_URL", "BUS_EVENTS_KEY", "NTFY_URL", "NTFY_TOKEN",
  "PAYRAIL_URL", "X402_RPC_URL", "X402_PAYMENT_NETWORK", "X402_PAYMENT_ASSET", "X402_PAYMENT_RECIPIENT",
  "MESHMARKET_URL", "MESHMARKET_SWEEP_MS", "MESHMARKET_MESH_PER_USD_CENT", "MESHMARKET_DAILY_CAP_MESH",
]) delete process.env[k];
Object.assign(process.env, {
  LSP_MCP_URL: LSP_URL,
  PAYRAIL_URL,
  X402_RPC_URL: PAYRAIL_URL,
  X402_PAYMENT_NETWORK: PAYRAIL_NETWORK,
  X402_PAYMENT_ASSET: PAYRAIL_ASSET,
  X402_PAYMENT_RECIPIENT: PAYRAIL_RECIPIENT,
  CREATOR_WORKER_READY: "1",
  DATABASE_URL,
  RUNTIME_ADMIN_KEY: ADMIN_KEY,
  VAULT_KEY,
  MESH_RECEIPT_SECRET: MESH_SECRET,
  GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
  RAILWAY_WEBHOOK_TOKEN: RAILWAY_TOKEN,
  BRAIN_WEBHOOK_SECRET: BRAIN_SECRET,
  PUBLIC_URL: BASE,
  RATE_LIMIT_PER_MIN: String(RATE_LIMIT),
  // reaper background timer OFF under test: the PGlite pool is pinned to one
  // connection, so an out-of-band sweep would contend with the test's own query.
  // The suite drives the reaper deterministically via POST /api/admin/grants/reap.
  REAP_INTERVAL_MS: "0",
  // MeshMarket rail: the fake exchange above; its sweep timer OFF for the same reason as the
  // reaper's (tests drive it with POST /api/admin/meshmarket/sweep).
  MESHMARKET_URL,
  MESHMARKET_SWEEP_MS: "0",
  // the runtime-wide daily cap is tested on its own (mesh-rail.test.js); the rest of the suite
  // buys far more than one day's 300 MESH, so it runs with the cap out of the way
  MESHMARKET_DAILY_CAP_MESH: "100000",
});

export const mod = await import(pathToFileURL(entryPath).href);
handler = (req) => mod.default.fetch(req, server);

export async function shutdown() {
  if (loopback.refused)
    console.warn(`harness: this machine refused ${loopback.refused} connection(s) to listeners that were up in this process (${loopback.bootRefused} before boot, ${loopback.refused - loopback.bootRefused} during the run); each was asked again. That is the machine's loopback, not the runtime: node test/loopback-check.mjs`);
  if (loopback.reset)
    console.warn(`harness: this machine reset ${loopback.reset} established connection(s) to the harness listener; those were NOT asked again (the runtime may have acted on them), so a test may have failed with ECONNRESET. That is the machine, not the runtime: node test/loopback-check.mjs`);
  server.stop(true);
  lspServer.stop(true);
  payrailServer.stop(true);
  meshmarketServer.stop(true);
  await pgServer.stop();
  await pg.close();
}

// ---- helpers --------------------------------------------------------------------
export async function req(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["content-type"] ??= "application/json";
  }
  const res = await localFetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}
export const admin = (method, path, opts = {}) => req(method, path, { ...opts, token: ADMIN_KEY });
export const hmacHex = (key, body) => createHmac("sha256", key).update(body).digest("hex");
export const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
export const s256 = (v) => createHash("sha256").update(v).digest("base64url");

export async function newTenant(name = "t", tier = "starter") {
  const r = await admin("POST", "/api/tenants", { body: { name, tier } });
  if (r.status !== 201) throw new Error("tenant create failed " + r.status + " " + r.text);
  return { id: r.json.tenant.id, token: r.json.rootGrant.token, grantId: r.json.rootGrant.id };
}
export async function mcp(token, method, params, id = 1) {
  return req("POST", "/mcp", { token, body: { jsonrpc: "2.0", id, method, params } });
}

// ---- fixed-window meters ----------------------------------------------------------
// The runtime's meters count in fixed wall-clock windows: a minute for checkNamedRateLimit
// (src/grants.js), an hour for the guest mint cap (src/guest.js). The count starts again when the
// window turns, so "fill the meter, the next call is refused" is only true if every call landed in
// ONE window. This runs `body` and keeps its outcome, pass or fail, only if the window did not turn
// while it ran. A run that straddled a turn is thrown away WHATEVER it said and done again, so the
// body gets the attempt number and must start from fresh grants (and a fresh ip for a guest).
// Nothing is waited for, and the runtime is in this process, so it reads this same clock.
export async function inOneWindow(body, windowMs = 60000) {
  for (let attempt = 1; ; attempt++) {
    const w = Math.floor(Date.now() / windowMs);
    let out, err;
    try { out = await body(attempt); } catch (e) { err = e; }
    if (Math.floor(Date.now() / windowMs) === w) {
      if (err) throw err;
      return out;
    }
    if (attempt === 3) throw new Error(`inOneWindow: the ${windowMs} ms window turned during each of 3 runs`, { cause: err });
  }
}
