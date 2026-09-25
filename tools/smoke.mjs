#!/usr/bin/env node
// Live smoke for a deployed runtime — the gate the ship script runs on staging
// before production, and on production right after. Exit 0 = green.
//
//   node tools/smoke.mjs <base-url> <ADMIN_KEY vault name> [--expect-version 0.3.1] [--issuer <public url>] [--read-only]
//
// The admin key is read from the vault inside this process and never printed.
// Writes it makes are confined to a tenant named smoke-<timestamp> (marked
// "smoke" in its name), so they are recognisable and harmless. --read-only skips
// every write (for a production check before a tenant cleanup policy exists).
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const [, , BASE_ARG, KEY_NAME, ...rest] = process.argv;
if (!BASE_ARG || !KEY_NAME) { console.error("usage: smoke.mjs <base-url> <ADMIN_KEY vault name> [--expect-version X] [--read-only]"); process.exit(2); }
const BASE = BASE_ARG.replace(/\/$/, "");
const flag = (n) => rest.includes(n);
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
const vault = readFileSync("C:/Users/vipth/.vault/secrets.env", "utf8");
const ADMIN = vault.match(new RegExp(`^${KEY_NAME}=(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!ADMIN) { console.error(`${KEY_NAME} not in vault`); process.exit(2); }

const s256 = (v) => createHash("sha256").update(v).digest("base64url");
async function req(method, path, { token, body, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method, redirect: "manual", signal: AbortSignal.timeout(20000),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["RED", `${name} — ${String(e.message).split(ADMIN).join("[admin]")}`]); }
}
const must = (c, m) => { if (!c) throw new Error(m); };

await check("health: 200, db up, version", async () => {
  const r = await req("GET", "/health");
  must(r.status === 200 && r.json?.ok && r.json.db, `status ${r.status}`);
  const want = opt("--expect-version");
  if (want) must(r.json.version === want, `version ${r.json.version} != ${want}`);
  must(r.json.fingerprints === undefined, "fingerprints are public");
});
await check("admin routes fail closed", async () => {
  must((await req("GET", "/api/admin/fingerprints")).status === 401, "no key accepted");
  must((await req("GET", "/api/admin/fingerprints", { token: "wrong" })).status === 401, "wrong key accepted");
  must((await req("GET", "/api/admin/fingerprints", { token: ADMIN })).status === 200, "right key refused");
});
await check("oauth metadata", async () => {
  const r = await req("GET", "/.well-known/oauth-authorization-server");
  const iss = (opt("--issuer") || BASE).replace(/\/$/, "");
  must(r.status === 200 && r.json.issuer === iss, `issuer ${r.json?.issuer} != ${iss}`);
});
await check("register refuses a non-allow-listed redirect", async () => {
  const r = await req("POST", "/oauth/register", { body: { client_name: "smoke-evil", redirect_uris: ["https://evil.example.com/cb"] } });
  must(r.status === 400, `status ${r.status}`);
});

if (!flag("--read-only")) {
  const redirect = "https://devdesk.meshtool.ai/runtime/callback";
  let tenant, cid, tok;
  await check("tenant + mixed-redirect client + approve + token → devdesk caps", async () => {
    const t = await req("POST", "/api/tenants", { token: ADMIN, body: { name: `smoke-${Date.now()}`, tier: "starter" } });
    must(t.status === 200 || t.status === 201, `tenant ${t.status}`);
    tenant = t.json.tenant?.id || t.json.id;
    const reg = await req("POST", "/oauth/register", { body: { client_name: "smoke", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", redirect] } });
    must(reg.status === 201, `register ${reg.status}`);
    cid = reg.json.client_id;
    const v = randomBytes(32).toString("base64url");
    const ap = await req("POST", "/oauth/approve", { token: ADMIN, body: { client_id: cid, redirect_uri: redirect, code_challenge: s256(v), state: "s", tenant } });
    must(ap.status === 200, `approve ${ap.status}`);
    const code = new URL(ap.json.redirect).searchParams.get("code");
    const tk = await req("POST", "/oauth/token", { body: { grant_type: "authorization_code", code, client_id: cid, redirect_uri: redirect, code_verifier: v } });
    must(tk.status === 200, `token ${tk.status}`);
    tok = tk.json;
    const g = await req("GET", "/api/grants/verify", { token: tok.access_token });
    must(g.json?.sub === "product:devdesk", `sub ${g.json?.sub}`);
  });
  await check("refresh keeps devdesk caps (no operator escalation)", async () => {
    const r = await req("POST", "/oauth/token", { body: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: cid } });
    must(r.status === 200, `refresh ${r.status}`);
    const g = await req("GET", "/api/grants/verify", { token: r.json.access_token });
    must(g.json?.sub === "product:devdesk" && !g.json.caps.includes("grant.issue"), `caps ${g.json?.caps}`);
    tok = r.json;
  });
  await check("MCP memory write → search round-trip", async () => {
    const call = (id, name, args) => req("POST", "/mcp", { token: tok.access_token, body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    const marker = `smoke-${randomBytes(4).toString("hex")}`;
    const w = await call(1, "memory_write", { partition: "product:devdesk", key: marker, content: `smoke check ${marker}` });
    must(w.status === 200 && !w.json?.result?.isError, `write ${w.status} ${w.text.slice(0, 120)}`);
    const s = await call(2, "memory_search", { partition: "product:devdesk", q: marker });
    must(s.status === 200 && s.text.includes(marker), `search ${s.status}`);
  });
}

for (const [st, n] of results) console.log(`${st === "ok" ? "  ok " : "  RED"}  ${n}`);
const red = results.filter(([st]) => st !== "ok").length;
console.log(red ? `\n${red} RED of ${results.length}` : `\nall ${results.length} green`);
process.exit(red ? 1 : 0);
