// Test harness: boots the runtime against a throwaway Postgres (PGlite over the
// Postgres wire protocol), on 127.0.0.1 only, with every outbound fetch blocked.
//
// The runtime under test is chosen by ENTRY below (or RUNTIME_ENTRY in the env,
// resolved relative to this folder). That is the only line that changes between
// testing src/runtime.js (the unsplit original), src/index.js and dist/runtime.js.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHash, createHmac } from "node:crypto";
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
const pgServer = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1", maxConnections: 8 });
/** Direct SQL against the throwaway DB, for tests that must set up a state no route can reach. */
export const dbQuery = (q, params = []) => pg.query(q, params);
await pgServer.start();

// PGlite is ONE Postgres session shared by every socket. Bun.SQL pools connections
// and names its prepared statements per connection, so two pooled connections
// collide on the shared session ("prepared statement ... already exists"). Pin the
// pool to one connection. This is a test-environment shim only: production talks
// to a real Postgres and constructs Bun.SQL exactly as the runtime does.
const RealSQL = globalThis.Bun.SQL;
globalThis.Bun.SQL = function PinnedSQL(url, opts) {
  return new RealSQL(url, { ...(opts || {}), max: 1 });
};

// ---- 2. outbound network: blocked ----------------------------------------------
const realFetch = globalThis.fetch;
export const blockedFetches = [];
let port = 0;
let lspPort = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "127.0.0.1" && (Number(url.port) === port || Number(url.port) === lspPort)) return realFetch(input, init);
  blockedFetches.push(url.href);
  throw new TypeError(`blocked by test harness: ${url.href}`);
};

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
    const v = await realFetch(`${BASE}/api/grants/verify`, { headers: { authorization: `Bearer ${token}` } });
    if (v.status !== 200) return rpcErr(403, (await v.json()).error || "bad_grant");
    const caps = (await v.json()).caps || [];
    if (!caps.includes("lsp.diagnose")) return rpcErr(403, "missing_cap", { need: "lsp.diagnose" });
    if (lsp.mode === "broke") return rpcErr(402, "budget_exhausted");
    if (lsp.mode === "slow") await new Promise((r) => setTimeout(r, 2500));
    const files = body.params?.arguments?.files || [];
    // Charge the call exactly as the real gate does (verify, then settle with the same token).
    const st = await realFetch(`${BASE}/api/grants/settle`, {
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
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler(req) });
port = server.port;
export const BASE = `http://127.0.0.1:${port}`;

// ---- 4. env, then import --------------------------------------------------------
for (const k of [
  "ANTHROPIC_API_KEY", "RAILWAY_API_TOKEN", "RAILWAY_OAUTH_CLIENT_ID", "RAILWAY_OAUTH_CLIENT_SECRET",
  "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MAP", "COG_BRIDGE_URL", "COG_BRIDGE_TOKEN", "COG_SYNC_TOKEN",
  "BRAIN_URL", "GRANT_SIGNING_KEY", "OAUTH_REDIRECT_HOSTS", "POSTGRES_URL", "PORT", "RUNTIME_MODE", "COG_MODEL",
  "LSP_MCP_URL", "LSP_MCP_TIMEOUT_MS",
]) delete process.env[k];
Object.assign(process.env, {
  LSP_MCP_URL: LSP_URL,
  CREATOR_WORKER_READY: "1",
  DATABASE_URL: `postgres://postgres:postgres@${pgServer.getServerConn()}/postgres`,
  RUNTIME_ADMIN_KEY: ADMIN_KEY,
  VAULT_KEY,
  MESH_RECEIPT_SECRET: MESH_SECRET,
  GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
  RAILWAY_WEBHOOK_TOKEN: RAILWAY_TOKEN,
  BRAIN_WEBHOOK_SECRET: BRAIN_SECRET,
  PUBLIC_URL: BASE,
  RATE_LIMIT_PER_MIN: String(RATE_LIMIT),
});

export const mod = await import(pathToFileURL(entryPath).href);
handler = (req) => mod.default.fetch(req, server);

export async function shutdown() {
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
  const res = await realFetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
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
