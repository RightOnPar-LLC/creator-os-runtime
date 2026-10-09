// creator-os mcp-gate — sign-in (OAuth 2.1 + PKCE) in front of the runtime's MCP.
// Holds no secrets. The access token Claude receives IS a limited runtime grant, minted by the owner in the cockpit.
// Flow: /register (stateless) → /authorize → cockpit #/connect (owner approves, grant minted in the browser) → POST /oauth/complete → code → /token → /mcp proxy.
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";

const env = Bun.env;
const VERSION = "0.1.0";
const RUNTIME = (env.RUNTIME_URL || "https://runtime.meshtool.ai").replace(/\/$/, "");
const COCKPIT = (env.COCKPIT_URL || RUNTIME).replace(/\/$/, "");
const VERIFY_TTL = Number(env.VERIFY_TTL_MS || 30_000);
const SRC = await Bun.file(import.meta.path).text().catch(() => "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// who may receive a grant: Claude web/desktop callbacks + loopback (Claude Code / Desktop)
const REDIRECT_OK = (u: string) => {
  try {
    const x = new URL(u);
    if (x.protocol === "https:" && /^([a-z0-9-]+\.)?claude\.(ai|com)$/.test(x.hostname)) return true;
    return x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
  } catch { return false; }
};
// what a gate token may ever do; anything stronger is refused at the door
const SAFE_CAPS = new Set(["memory.read", "memory.write", "cog.plan", "tenant.read"]);
const TOOL_CAP: Record<string, string | null> = { runtime_health: null, grant_verify: null, memory_search: "memory.read", memory_write: "memory.write", memory_forget: "memory.write", cog_plan: "cog.plan" };

type Client = { n: string; r: string[] };
const encClient = (c: Client) => "c1." + Buffer.from(JSON.stringify(c)).toString("base64url");
const decClient = (id: string): Client | null => {
  if (!id || !id.startsWith("c1.")) return null;
  try { const c = JSON.parse(Buffer.from(id.slice(3), "base64url").toString()); return Array.isArray(c.r) && c.r.length && c.r.every(REDIRECT_OK) ? { n: String(c.n || "MCP client").slice(0, 60), r: c.r.map(String) } : null; } catch { return null; }
};

// short-lived state, in memory only (a restart just means "start the sign-in again")
type Pending = { client_id: string; name: string; redirect_uri: string; challenge: string; state: string; exp: number };
type Code = { grant: string; client_id: string; redirect_uri: string; challenge: string; exp: number };
const pending = new Map<string, Pending>(), codes = new Map<string, Code>();
const vcache = new Map<string, { ok: boolean; info: any; at: number }>();
const cap = (m: Map<string, any>, n: number) => { while (m.size > n) m.delete(m.keys().next().value as string); };
const sweep = () => { const n = Date.now(); for (const [k, v] of pending) if (v.exp < n) pending.delete(k); for (const [k, v] of codes) if (v.exp < n) codes.delete(k); };

async function verify(grant: string, fresh = false) {
  const key = sha(grant), hit = vcache.get(key);
  if (!fresh && hit && Date.now() - hit.at < (hit.ok ? VERIFY_TTL : 3000)) return hit;
  let ok = false, info: any = null;
  try { const r = await fetch(RUNTIME + "/api/grants/verify", { headers: { authorization: "Bearer " + grant } }); info = await r.json().catch(() => null); ok = r.status === 200 && !!info?.id; } catch {}
  const v = { ok, info, at: Date.now() }; vcache.set(key, v); cap(vcache, 500); return v;
}
const safeGrant = (info: any) => Array.isArray(info?.caps) && info.caps.length > 0 && info.caps.every((c: string) => SAFE_CAPS.has(c));
const bearer = (c: any) => { const h = c.req.header("authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7).trim() : ""; };
const self = (c: any) => {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return "https://" + env.RAILWAY_PUBLIC_DOMAIN;
  const u = new URL(c.req.url); return `${c.req.header("x-forwarded-proto") || u.protocol.replace(":", "")}://${c.req.header("host") || u.host}`;
};
const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
const page = (c: any, title: string, text: string, status = 200) => c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono&display=swap">
<style>body{margin:0;min-height:100vh;background:#050506;color:#F6F1E4;font:16px/1.55 Geist,system-ui,sans-serif;background-image:linear-gradient(rgba(245,197,66,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(245,197,66,.035) 1px,transparent 1px);background-size:48px 48px;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:620px;width:100%;border:1px solid #34313B;border-radius:16px;background:rgba(14,14,17,.85);padding:28px}.e{font:12px 'Geist Mono',monospace;letter-spacing:.12em;color:#F5C542;text-transform:uppercase}h1{margin:8px 0 10px;font-size:30px;letter-spacing:-.02em}p{color:#B3AB98;margin:0 0 10px}code{font-family:'Geist Mono',monospace;color:#19F0D8;word-break:break-all}a{color:#F5C542}</style></head>
<body><main><div class="e">creator-os · mcp gate</div><h1>${esc(title)}</h1>${text}</main></body></html>`, status);

const app = new Hono();
app.use("*", async (c, next) => {
  sweep();
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version", "access-control-max-age": "600" } });
  await next();
  c.header("access-control-allow-origin", "*");
  c.header("access-control-expose-headers", "www-authenticate, mcp-session-id");
  c.header("x-content-type-options", "nosniff");
});

// discovery
const asMeta = (c: any) => { const s = self(c); return { issuer: s, authorization_endpoint: s + "/authorize", token_endpoint: s + "/token", registration_endpoint: s + "/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["runtime"], service_documentation: RUNTIME + "/docs" }; };
const prMeta = (c: any) => { const s = self(c); return { resource: s + "/mcp", authorization_servers: [s], scopes_supported: ["runtime"], bearer_methods_supported: ["header"], resource_name: "creator-os runtime" }; };
app.get("/.well-known/oauth-authorization-server", (c) => c.json(asMeta(c)));
app.get("/.well-known/oauth-authorization-server/*", (c) => c.json(asMeta(c)));
app.get("/.well-known/openid-configuration", (c) => c.json(asMeta(c)));
app.get("/.well-known/oauth-protected-resource", (c) => c.json(prMeta(c)));
app.get("/.well-known/oauth-protected-resource/*", (c) => c.json(prMeta(c)));

// dynamic client registration — stateless: the client id carries its own redirect list, checked against the allowlist every time
app.post("/register", async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const r = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 10) : [];
  if (!r.length || !r.every(REDIRECT_OK)) return c.json({ error: "invalid_redirect_uri", error_description: "only Claude callbacks and localhost may receive a grant" }, 400);
  const client: Client = { n: String(b.client_name || "MCP client").slice(0, 60), r };
  return c.json({ client_id: encClient(client), client_name: client.n, redirect_uris: r, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
});

// authorize → hand the owner to the cockpit's Connect page
app.get("/authorize", (c) => {
  const q = c.req.query(), client = decClient(q.client_id || "");
  if (!client) return page(c, "Unknown app", "<p>This sign-in link isn't from an app registered with the gate. Nothing was shared.</p>", 400);
  const ru = q.redirect_uri || client.r[0];
  if (!client.r.includes(ru) || !REDIRECT_OK(ru)) return page(c, "Wrong return address", "<p>The app asked to send you somewhere it didn't register. Nothing was shared.</p>", 400);
  const back = (p: Record<string, string>) => { const u = new URL(ru); for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v); if (q.state) u.searchParams.set("state", q.state); return c.redirect(u.toString(), 302); };
  if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
  if (!q.code_challenge || q.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "PKCE S256 required" });
  const req = randomBytes(16).toString("hex");
  pending.set(req, { client_id: q.client_id, name: client.n, redirect_uri: ru, challenge: q.code_challenge, state: q.state || "", exp: Date.now() + 10 * 60_000 }); cap(pending, 500);
  return c.redirect(`${COCKPIT}/#/connect?gate=${encodeURIComponent(self(c))}&req=${req}&client=${encodeURIComponent(client.n)}&to=${encodeURIComponent(new URL(ru).host)}`, 302);
});

// the cockpit posts back here (top-level form POST from the owner's browser) with the decision and, if approved, the limited grant
app.post("/oauth/complete", async (c) => {
  const f: any = await c.req.parseBody().catch(() => ({}));
  const id = String(f.req || ""), p = pending.get(id);
  if (!p) return page(c, "This sign-in expired", "<p>Sign-in links last 10 minutes. Start again from Claude.</p>", 400);
  pending.delete(id);
  const u = new URL(p.redirect_uri); if (p.state) u.searchParams.set("state", p.state);
  if (f.decision !== "approve") { u.searchParams.set("error", "access_denied"); return c.redirect(u.toString(), 302); }
  const grant = String(f.grant || ""), v = await verify(grant, true);
  if (!v.ok || !safeGrant(v.info)) { u.searchParams.set("error", "access_denied"); u.searchParams.set("error_description", "the gate only passes limited grants"); return c.redirect(u.toString(), 302); }
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { grant, client_id: p.client_id, redirect_uri: p.redirect_uri, challenge: p.challenge, exp: Date.now() + 5 * 60_000 }); cap(codes, 500);
  u.searchParams.set("code", code);
  return c.redirect(u.toString(), 302);
});

// token: code + PKCE → the grant itself as the access token (refresh = same grant while it lives)
app.post("/token", async (c) => {
  c.header("cache-control", "no-store");
  const ct = c.req.header("content-type") || "";
  const f: any = ct.includes("json") ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}));
  const err = (e: string, d?: string) => c.json({ error: e, ...(d ? { error_description: d } : {}) }, 400);
  let grant = "";
  if (f.grant_type === "authorization_code") {
    const k = codes.get(String(f.code || "")); if (!k) return err("invalid_grant", "code unknown, used or expired");
    codes.delete(String(f.code));
    if (f.client_id && f.client_id !== k.client_id) return err("invalid_grant", "client mismatch");
    if (f.redirect_uri && f.redirect_uri !== k.redirect_uri) return err("invalid_grant", "redirect mismatch");
    if (!f.code_verifier || createHash("sha256").update(String(f.code_verifier)).digest("base64url") !== k.challenge) return err("invalid_grant", "PKCE check failed");
    grant = k.grant;
  } else if (f.grant_type === "refresh_token") {
    const rt = String(f.refresh_token || ""); if (!rt.startsWith("rt.")) return err("invalid_grant");
    grant = rt.slice(3);
  } else return err("unsupported_grant_type");
  const v = await verify(grant, true);
  if (!v.ok || !safeGrant(v.info)) return err("invalid_grant", "grant no longer active");
  const ttl = Math.max(60, Number(v.info.exp) - Math.floor(Date.now() / 1000));
  return c.json({ access_token: grant, token_type: "Bearer", expires_in: Math.min(ttl, 30 * 86400), refresh_token: "rt." + grant, scope: "runtime" });
});

// the MCP itself: auth at the door, only the tools the grant can use, everything else passes straight to the runtime
const unauth = (c: any, why: string) => { c.header("www-authenticate", `Bearer resource_metadata="${self(c)}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${why}"`); return c.json({ error: "unauthorized", detail: why }, 401); };
app.get("/mcp", (c) => { if (!bearer(c)) return unauth(c, "sign in required"); c.header("allow", "POST"); return c.body(null, 405); });
app.delete("/mcp", (c) => c.body(null, 204));
app.post("/mcp", async (c) => {
  const t = bearer(c); if (!t) return unauth(c, "sign in required");
  const v = await verify(t); if (!v.ok) return unauth(c, "grant not active"); if (!safeGrant(v.info)) return unauth(c, "grant too powerful for the gate");
  const raw = await c.req.text(); let msg: any;
  try { msg = JSON.parse(raw); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse_error" } }, 400); }
  if (Array.isArray(msg)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch_not_supported" } }, 400);
  const caps = new Set<string>(v.info.caps);
  const allowed = (n: string) => n in TOOL_CAP && (TOOL_CAP[n] === null || caps.has(TOOL_CAP[n]!));
  if (msg.method === "tools/call" && !allowed(String(msg.params?.name))) return c.json({ jsonrpc: "2.0", id: msg.id ?? null, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not_allowed_through_gate", tool: msg.params?.name ?? null }) }] } });
  const r = await fetch(RUNTIME + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + t }, body: raw });
  if (r.status === 202) return c.body(null, 202);
  const text = await r.text();
  if (msg.method === "tools/list" || msg.method === "initialize") {
    try {
      const j = JSON.parse(text);
      if (j.result?.tools) j.result.tools = j.result.tools.filter((x: any) => allowed(x.name));
      if (msg.method === "initialize" && j.result) { j.result.serverInfo = { name: "creator-os runtime", version: String(j.result.serverInfo?.version || "") }; j.result.instructions = "creator-os runtime through the gate. memory_search / memory_write use the shared 'tenant' partition by default; keep your own notes in partition 'agent:claude'. cog_plan only proposes — it never deploys."; }
      return c.json(j, r.status as any);
    } catch {}
  }
  return new Response(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" } });
});

// human + health
app.get("/", (c) => page(c, "Sign-in for your runtime", `<p>Add this address as a custom connector in Claude:</p><p><code>${esc(self(c))}/mcp</code></p><p>Claude sends you to your cockpit to approve. It gets its own limited grant (memory + COG plans, 30 days, cancel anytime on the Grants page). Your key never leaves the cockpit.</p>`));
app.get("/health", (c) => c.json({ ok: true, service: "creator-os-mcp-gate", version: VERSION, runtime: RUNTIME, cockpit: COCKPIT, self: self(c), pending: pending.size, codes: codes.size, source: { sha256: sha(SRC), bytes: Buffer.byteLength(SRC) } }));

export default { port: Number(env.PORT || 8080), fetch: app.fetch };
