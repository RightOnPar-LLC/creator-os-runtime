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
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "127.0.0.1" && (Number(url.port) === port || Number(url.port) === lspPort)) return localFetch(input, init);
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
  "LSP_MCP_URL", "LSP_MCP_TIMEOUT_MS", "REAP_INTERVAL_MS", "BUS_EVENTS_URL", "BUS_EVENTS_KEY",
]) delete process.env[k];
Object.assign(process.env, {
  LSP_MCP_URL: LSP_URL,
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
