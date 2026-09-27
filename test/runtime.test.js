// Characterisation suite for creator-os-runtime. Written against the UNSPLIT
// src/runtime.js (the proven-readable form of the live 0.3.0 bundle) so that any
// refactor has to keep every behaviour pinned here.
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mod, entryPath, BASE, ADMIN_KEY, GITHUB_SECRET, BRAIN_SECRET, MESH_SECRET, RAILWAY_TOKEN, RATE_LIMIT,
  blockedFetches, req, admin, hmacHex, sha256Hex, s256, newTenant, mcp, shutdown, dbQuery, lsp, overlayHash,
} from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
afterAll(shutdown);

// ------------------------------------------------------------------------------------
describe("1. /health", () => {
  test("shape, version, armed flags, db", async () => {
    const r = await req("GET", "/health");
    expect(r.status).toBe(200);
    const h = r.json;
    expect(h.ok).toBe(true);
    expect(h.service).toBe("creator-os-runtime");
    expect(h.version).toBe("0.3.4");
    expect(h.policy).toBe("p1");
    expect(h.db).toBe(true);
    expect(h.killSwitch).toBe(false);
    expect(h.armed).toEqual({
      admin: true, vault: true, railway: false, railwayOAuth: false, stripe: false,
      railwayWebhook: true, github: true, brain: true, mesh: true, anthropic: false,
      brainOut: false, cognitiveBridge: false, sync: false, lspMcp: true,
    });
    // 2026-09-25: fingerprints are no longer public.
    expect(h.fingerprints).toBeUndefined();
    expect(typeof h.time).toBe("string");
  });

  test("secret fingerprints are admin-only (GET /api/admin/fingerprints)", async () => {
    expect((await req("GET", "/api/admin/fingerprints")).status).toBe(401);
    const r = await admin("GET", "/api/admin/fingerprints");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.fingerprints).sort()).toEqual(
      ["admin", "anthropic", "brain", "cognitiveBridge", "github", "mesh", "railway", "railwayWebhook", "stripe", "sync", "vault"],
    );
    expect(r.json.fingerprints.admin).toBe(sha256Hex(ADMIN_KEY).slice(0, 8));
    expect(r.json.fingerprints.anthropic).toBeNull();
  });

  test("source hash is the sha256 of the file that was loaded as the entry", async () => {
    const r = await req("GET", "/health?chunks=1");
    const text = readFileSync(entryPath, "utf8");
    expect(r.json.source.sha256).toBe(sha256Hex(text));
    expect(r.json.source.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(r.json.source.chunks.length).toBe(Math.ceil(text.length / 4096));
  });

  test("exports", () => {
    expect(mod.VERSION).toBe("0.3.4");
    expect(typeof mod.app.fetch).toBe("function");
    expect(typeof mod.gatehouseEvaluate).toBe("function");
    expect(typeof mod.attenuationViolations).toBe("function");
    expect(Object.keys(mod.TIERS)).toEqual(["guest", "starter", "pro", "studio", "house"]);
    expect(Object.keys(mod.TEMPLATES)).toEqual(
      ["probe", "tip-alert-bot", "paywall-link", "clip-poster", "dm-autoresponder", "webhook-relay", "repo-app", "builder"],
    );
    expect(mod.CAPS.length).toBe(25);
    expect(mod.CAPS.slice(20)).toEqual(["code.write", "lsp.diagnose", "lsp.hover", "lsp.definition", "lsp.references"]);
    expect(mod.default.port).toBe(3000);
    expect(mod.default.fetch).toBe(mod.app.fetch);
    expect(Object.keys(mod).sort()).toEqual(
      ["CAPS", "TEMPLATES", "TIERS", "VERSION", "app", "attenuationViolations", "default", "gatehouseEvaluate"],
    );
  });
});

// ------------------------------------------------------------------------------------
describe("2. route table", () => {
  test("ordered method+path list matches test/routes.snapshot.json", async () => {
    const appRoutes = mod.app.routes.map((r) => `${r.method} ${r.path}`);
    const inventory = (await req("GET", "/routes")).json.routes.map((r) => `${r.method} ${r.path} :: ${r.auth}`);
    const snap = { count: appRoutes.length, appRoutes, inventory };
    const file = resolve(here, "routes.snapshot.json");
    if (!existsSync(file) || process.env.UPDATE_SNAPSHOT === "1") {
      writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
    }
    expect(snap).toEqual(JSON.parse(readFileSync(file, "utf8")));
  });

  test("404 shape", async () => {
    const r = await req("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found", hint: "GET /routes" });
  });

  test("/.well-known/creator-os.json", async () => {
    const r = await req("GET", "/.well-known/creator-os.json");
    expect(r.status).toBe(200);
    expect(r.json.version).toBe("0.3.4");
    expect(r.json.caps).toEqual(mod.CAPS);
    expect(r.json.templates.probe).toEqual({ desc: "Tiny HTTP responder that proves the deploy path", needs: [], estCents: 25 });
  });

  test("/selftest passes", async () => {
    const r = await req("GET", "/selftest");
    expect(r.status).toBe(200);
    expect(r.json.pass).toBe(true);
    expect(r.json.count).toBeGreaterThan(5);
  });

  test("GET /mcp describes the transport", async () => {
    const r = await req("GET", "/mcp");
    expect(r.json.transport).toBe("streamable-http");
    expect(r.json.tools).toContain("memory_write");
  });
});

// ------------------------------------------------------------------------------------
describe("3. OAuth 2.1 + PKCE client flow", () => {
  const redirect = "https://devdesk.meshtool.ai/runtime/callback";
  let clientId, tenant;

  const approve = async (challenge, state = "st-1") =>
    admin("POST", "/oauth/approve", {
      body: { client_id: clientId, redirect_uri: redirect, code_challenge: challenge, state, tenant: tenant.id },
    });

  test("authorization-server + protected-resource metadata", async () => {
    const r = await req("GET", "/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      issuer: BASE,
      authorization_endpoint: BASE + "/oauth/authorize",
      token_endpoint: BASE + "/oauth/token",
      registration_endpoint: BASE + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["grant.issue", "grant.read", "cog.plan", "ledger.read", "deploy.worker", "worker.status", "cog.execute", "lsp.diagnose"],
    });
    const p = await req("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(p.json.resource).toBe(BASE + "/mcp");
  });

  test("register: allow-listed https redirect accepted, others refused", async () => {
    const bad = await req("POST", "/oauth/register", { body: { client_name: "evil", redirect_uris: ["https://evil.example.com/cb"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_redirect_uri");
    const plain = await req("POST", "/oauth/register", { body: { redirect_uris: ["http://devdesk.meshtool.ai/cb"] } });
    expect(plain.status).toBe(400);
    const none = await req("POST", "/oauth/register", { body: {} });
    expect(none.status).toBe(400);
    const ok = await req("POST", "/oauth/register", { body: { client_name: "DevDesk", redirect_uris: [redirect] } });
    expect(ok.status).toBe(201);
    expect(ok.json.client_id).toMatch(/^oc_/);
    expect(ok.json.token_endpoint_auth_method).toBe("none");
    clientId = ok.json.client_id;
    tenant = await newTenant("oauth-tenant", "pro");
  });

  test("authorize renders the consent page; bad requests refused", async () => {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: s256("v"), code_challenge_method: "S256", state: "<x>" });
    const r = await req("GET", "/oauth/authorize?" + q);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.text).toContain("Approve connector");
    expect(r.text).toContain("product:devdesk");
    expect(r.text).not.toContain("<x>");
    const noPkce = await req("GET", "/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect }));
    expect(noPkce.status).toBe(400);
    expect(noPkce.json.error).toBe("pkce_s256_required");
    const mismatch = await req("GET", "/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect + "x", code_challenge: "c" }));
    expect(mismatch.json.error).toBe("redirect_uri_mismatch");
  });

  test("approve refused without / with wrong admin key", async () => {
    const body = { client_id: clientId, redirect_uri: redirect, code_challenge: s256("v"), tenant: tenant.id };
    const none = await req("POST", "/oauth/approve", { body });
    expect(none.status).toBe(401);
    expect(none.json.error).toBe("admin_required");
    const wrong = await req("POST", "/oauth/approve", { body, token: ADMIN_KEY + "x" });
    expect(wrong.status).toBe(401);
    const noTenant = await admin("POST", "/oauth/approve", { body: { ...body, tenant: "t_missing" } });
    expect(noTenant.status).toBe(404);
  });

  let access, refresh;
  test("code + PKCE S256 -> access token; wrong verifier refused; code single-use", async () => {
    // wrong verifier (burns that code)
    const a1 = await approve(s256("right-verifier-1"));
    expect(a1.status).toBe(200);
    const u1 = new URL(a1.json.redirect);
    expect(u1.origin + u1.pathname).toBe(redirect);
    expect(u1.searchParams.get("state")).toBe("st-1");
    const bad = await req("POST", "/oauth/token", {
      raw: new URLSearchParams({ grant_type: "authorization_code", code: u1.searchParams.get("code"), client_id: clientId, redirect_uri: redirect, code_verifier: "wrong" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "invalid_grant", error_description: "pkce verification failed" });

    // right verifier
    const verifier = "right-verifier-2-" + "x".repeat(40);
    const a2 = await approve(s256(verifier), "st-2");
    const code = new URL(a2.json.redirect).searchParams.get("code");
    const form = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier };
    const ok = await req("POST", "/oauth/token", {
      raw: new URLSearchParams(form).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.token_type).toBe("Bearer");
    expect(ok.json.access_token).toMatch(/^cog1\./);
    expect(ok.json.refresh_token.length).toBeGreaterThan(20);
    expect(ok.json.scope).toBe("memory.read memory.write ledger.read tenant.read deploy.worker worker.status");
    expect(ok.json.expires_in).toBeGreaterThan(80000);
    access = ok.json.access_token;
    refresh = ok.json.refresh_token;

    const replay = await req("POST", "/oauth/token", { body: form });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
    const unsupported = await req("POST", "/oauth/token", { body: { grant_type: "password" } });
    expect(unsupported.json.error).toBe("unsupported_grant_type");
  });

  test("grant verify with the access token -> product:devdesk caps", async () => {
    const r = await req("GET", "/api/grants/verify", { token: access });
    expect(r.status).toBe(200);
    expect(r.json.sub).toBe("product:devdesk");
    expect(r.json.caps).toEqual(["memory.read", "memory.write", "ledger.read", "tenant.read", "deploy.worker", "worker.status"]);
    expect(r.json.scope.memory.partitions).toEqual(["agent:", "product:devdesk"]);
    expect(r.json.tenant).toBe(tenant.id);
    expect(r.json.depth).toBe(1);
    expect(r.json.constraints.allowDelete).toBe(false);
  });

  test("refresh_token rotates; old refresh token refused", async () => {
    const r = await req("POST", "/oauth/token", { body: { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId } });
    expect(r.status).toBe(200);
    expect(r.json.access_token).toMatch(/^cog1\./);
    expect(r.json.refresh_token).not.toBe(refresh);
    const v = await req("GET", "/api/grants/verify", { token: r.json.access_token });
    expect(v.json.sub).toBe("product:devdesk");
    const again = await req("POST", "/oauth/token", { body: { grant_type: "refresh_token", refresh_token: refresh } });
    expect(again.status).toBe(400);
    // 2026-09-25: a SECOND presentation of an already-rotated refresh token is
    // reuse (theft), not just "unknown" — and it revokes the grant that
    // refresh chain was issued for, locking out the rotated (v.access_token)
    // token too so neither the thief nor the legitimate holder stays trusted.
    expect(again.json.error_description).toBe("refresh token reused; grant revoked");
    const revoked = await req("GET", "/api/grants/verify", { token: r.json.access_token });
    expect(revoked.status).toBe(401);
    expect(revoked.json.error).toBe("grant_revoked");
    const events = (await admin("GET", "/api/admin/events")).json.events.filter((e) => e.type === "oauth.refresh_reuse_detected");
    expect(events.length).toBe(1);
  });

  // 2026-09-25: refresh used the client's FIRST registered redirect to pick the
  // profile. A client registered [claude.ai, devdesk] and approved on devdesk
  // got OPERATOR caps (grant.issue, cog.plan) once its grant was re-issued.
  test("refresh never escalates: a client approved on devdesk keeps devdesk caps even if its FIRST redirect is claude.ai", async () => {
    const mixed = ["https://claude.ai/api/mcp/auth_callback", redirect];
    const reg = await req("POST", "/oauth/register", { body: { client_name: "mixed", redirect_uris: mixed } });
    expect(reg.status).toBe(201);
    const cid = reg.json.client_id;
    const verifier = "mixed-verifier-" + "y".repeat(40);
    const ap = await admin("POST", "/oauth/approve", {
      body: { client_id: cid, redirect_uri: redirect, code_challenge: s256(verifier), state: "m", tenant: tenant.id },
    });
    const code = new URL(ap.json.redirect).searchParams.get("code");
    const tok = await req("POST", "/oauth/token", {
      body: { grant_type: "authorization_code", code, client_id: cid, redirect_uri: redirect, code_verifier: verifier },
    });
    expect(tok.status).toBe(200);
    const g1 = await req("GET", "/api/grants/verify", { token: tok.json.access_token });
    expect(g1.json.sub).toBe("product:devdesk");
    // Force the RE-ISSUE branch (grant within an hour of expiry), which is where
    // the profile is re-derived.
    const upd = await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [Math.floor(Date.now() / 1000) + 60, g1.json.id]);
    expect(upd.affectedRows).toBe(1);
    const ref = await req("POST", "/oauth/token", { body: { grant_type: "refresh_token", refresh_token: tok.json.refresh_token, client_id: cid } });
    expect(ref.status).toBe(200);
    const g2 = await req("GET", "/api/grants/verify", { token: ref.json.access_token });
    expect(g2.json.sub).toBe("product:devdesk");
    expect(g2.json.caps).toEqual(["memory.read", "memory.write", "ledger.read", "tenant.read", "deploy.worker", "worker.status"]);
    expect(g2.json.caps).not.toContain("grant.issue");
    expect(ref.json.scope).toBe("memory.read memory.write ledger.read tenant.read deploy.worker worker.status");
  });
});

// ------------------------------------------------------------------------------------
describe("4. MCP", () => {
  let t;
  test("missing / bad grant -> 401 with resource metadata pointer", async () => {
    t = await newTenant("mcp-tenant");
    const r = await req("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    const b = await mcp("cog1.bad.token", "initialize", {});
    expect(b.status).toBe(401);
    expect(b.json.error).toBe("bad_grant");
  });

  test("initialize + tools/list + ping + unknown method", async () => {
    const i = await mcp(t.token, "initialize", { protocolVersion: "2025-06-18" });
    expect(i.json.result.serverInfo).toEqual({ name: "creator-os-runtime", version: "0.3.4" });
    expect(i.json.result.protocolVersion).toBe("2025-06-18");
    const l = await mcp(t.token, "tools/list", {}, 2);
    expect(l.json.id).toBe(2);
    expect(l.json.result.tools.map((x) => x.name)).toEqual([
      "guest_welcome",
      "runtime_health", "grant_verify", "grant_issue", "grant_list", "grant_revoke", "cog_plan", "cog_execute",
      "deploy_worker", "deploy_status", "ledger_query", "memory_search", "memory_write", "memory_forget",
    ]);
    expect((await mcp(t.token, "ping", {})).json.result).toEqual({});
    expect((await mcp(t.token, "nope", {})).json.error.code).toBe(-32601);
    const n = await mcp(t.token, "notifications/initialized", {});
    expect(n.status).toBe(202);
  });

  test("memory write then search round-trip with a grant", async () => {
    const w = await mcp(t.token, "tools/call", { name: "memory_write", arguments: { partition: "notes", key: "k1", content: "the orchid blooms at dawn", tags: ["a"] } });
    expect(w.status).toBe(200);
    const mem = w.json.result.structuredContent.memory;
    expect(mem.partition).toBe("notes");
    expect(mem.key).toBe("k1");
    const s = await mcp(t.token, "tools/call", { name: "memory_search", arguments: { q: "orchid", partition: "notes" } });
    const hits = s.json.result.structuredContent.memories;
    expect(hits.length).toBe(1);
    expect(hits[0].content).toBe("the orchid blooms at dawn");
    expect(JSON.parse(s.json.result.content[0].text)).toEqual(s.json.result.structuredContent);
    // REST sees the same row
    const rest = await req("GET", "/api/memory?partition=notes&q=orchid", { token: t.token });
    expect(rest.json.memories[0].id).toBe(mem.id);
  });

  test("a call lacking the cap is refused; unknown tool refused", async () => {
    const child = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:reader", caps: ["memory.read"], ttlSec: 600 } });
    expect(child.status).toBe(201);
    const denied = await mcp(child.json.token, "tools/call", { name: "memory_write", arguments: { content: "x" } });
    expect(denied.status).toBe(200);
    expect(denied.json.result.isError).toBe(true);
    expect(JSON.parse(denied.json.result.content[0].text)).toEqual({ error: "missing_cap", detail: { need: "memory.write" } });
    const allowed = await mcp(child.json.token, "tools/call", { name: "memory_search", arguments: { q: "orchid" } });
    expect(allowed.json.result.isError).toBeUndefined();
    const unknown = await mcp(t.token, "tools/call", { name: "rm_rf", arguments: {} });
    expect(unknown.json.error).toEqual({ code: -32602, message: "unknown_tool" });
  });

  test("runtime_health + grant_verify tools", async () => {
    const h = await mcp(t.token, "tools/call", { name: "runtime_health" });
    expect(h.json.result.structuredContent.version).toBe("0.3.4");
    const v = await mcp(t.token, "tools/call", { name: "grant_verify" });
    expect(v.json.result.structuredContent.sub).toBe("tenant:root");
  });
});

// ------------------------------------------------------------------------------------
describe("5. admin fail-closed + kill switch", () => {
  test("admin routes refuse missing / wrong key", async () => {
    for (const [m, p] of [["GET", "/api/admin/overview"], ["GET", "/api/tenants"], ["POST", "/api/admin/kill"], ["GET", "/api/admin/events"]]) {
      const none = await req(m, p);
      expect(none.status).toBe(401);
      expect(none.json.error).toBe("admin_required");
      const wrong = await req(m, p, { token: "not-the-key" });
      expect(wrong.status).toBe(401);
    }
    // 2026-09-25: admin auth reads ONLY the Authorization header now. x-grant is
    // the low-trust fallback channel for grant tokens; the admin key must not
    // also work there (one less place the master key could leak into).
    const viaXGrant = await req("GET", "/api/admin/overview", { headers: { "x-grant": ADMIN_KEY } });
    expect(viaXGrant.status).toBe(401);
    expect(viaXGrant.json.error).toBe("admin_required");
  });

  test("with RUNTIME_ADMIN_KEY unset, admin routes 503 unarmed", async () => {
    const saved = process.env.RUNTIME_ADMIN_KEY;
    delete process.env.RUNTIME_ADMIN_KEY;
    try {
      const r = await req("GET", "/api/admin/overview", { token: saved });
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: "unarmed", detail: { needs: "RUNTIME_ADMIN_KEY" } });
    } finally {
      process.env.RUNTIME_ADMIN_KEY = saved;
    }
    expect((await admin("GET", "/api/admin/overview")).status).toBe(200);
  });

  test("kill pauses grant routes (503 runtime_paused), admin still works; resume restores", async () => {
    const t = await newTenant("kill-tenant");
    expect((await req("GET", "/api/grants/verify", { token: t.token })).status).toBe(200);
    const k = await admin("POST", "/api/admin/kill");
    expect(k.json).toEqual({ killSwitch: true });
    const paused = await req("GET", "/api/grants/verify", { token: t.token });
    expect(paused.status).toBe(503);
    expect(paused.json.error).toBe("runtime_paused");
    const mem = await req("POST", "/api/memory", { token: t.token, body: { content: "x" } });
    expect(mem.status).toBe(503);
    const ov = await admin("GET", "/api/admin/overview");
    expect(ov.status).toBe(200);
    expect(ov.json.killSwitch).toBe(true);
    expect((await req("GET", "/health")).json.killSwitch).toBe(true);
    const r = await admin("POST", "/api/admin/resume");
    expect(r.json).toEqual({ killSwitch: false });
    expect((await req("GET", "/api/grants/verify", { token: t.token })).status).toBe(200);
  });

  test("suspended tenant -> 403; revoked grant -> 401", async () => {
    const t = await newTenant("suspend-tenant");
    await admin("POST", `/api/tenants/${t.id}/suspend`);
    expect((await req("GET", "/api/grants/verify", { token: t.token })).json.error).toBe("tenant_suspended");
    await admin("POST", `/api/tenants/${t.id}/resume`);
    expect((await req("GET", "/api/grants/verify", { token: t.token })).status).toBe(200);
    const rv = await admin("POST", `/api/admin/grants/${t.grantId}/revoke`, { body: { reason: "test" } });
    expect(rv.json.revoked).toEqual([t.grantId]);
    const after = await req("GET", "/api/grants/verify", { token: t.token });
    expect(after.status).toBe(401);
    expect(after.json.error).toBe("grant_revoked");
  });
});

// ------------------------------------------------------------------------------------
describe("6. webhooks", () => {
  test("github: good signature accepted, bad refused, replay not double-processed", async () => {
    const body = JSON.stringify({ repository: { full_name: "o/r" }, ref: "refs/heads/main", after: "abc" });
    const sig = "sha256=" + hmacHex(GITHUB_SECRET, body);
    const hdr = { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "delivery-1" };
    const bad = await req("POST", "/webhooks/github", { raw: body, headers: { ...hdr, "x-hub-signature-256": "sha256=" + "0".repeat(64) } });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe("bad_signature");
    const missing = await req("POST", "/webhooks/github", { raw: body, headers: hdr });
    expect(missing.status).toBe(401);
    const ok = await req("POST", "/webhooks/github", { raw: body, headers: { ...hdr, "x-hub-signature-256": sig } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ received: true });
    const replay = await req("POST", "/webhooks/github", { raw: body, headers: { ...hdr, "x-hub-signature-256": sig } });
    expect(replay.json).toEqual({ received: true, replay: true });
    const events = (await admin("GET", "/api/admin/events")).json.events.filter((e) => e.type === "repo.push");
    expect(events.length).toBe(1);
    const hooks = (await admin("GET", "/api/admin/webhooks")).json.webhooks.filter((w) => w.source === "github");
    expect(hooks.length).toBe(1);
    expect(hooks[0].handled).toBe(true);
    // 2026-09-25: the same signed body with a NEW delivery id is still a replay
    // (x-github-delivery is not covered by the signature).
    const forged = await req("POST", "/webhooks/github", { raw: body, headers: { ...hdr, "x-github-delivery": "delivery-FORGED", "x-hub-signature-256": sig } });
    expect(forged.json).toEqual({ received: true, replay: true });
    expect((await admin("GET", "/api/admin/events")).json.events.filter((e) => e.type === "repo.push").length).toBe(1);
    // A row written by 0.3.0 (keyed by delivery id, not body hash) still blocks a
    // replay of that body under a new delivery id (review on PR #5).
    const oldBody = JSON.stringify({ repository: { full_name: "o/legacy" }, ref: "refs/heads/main", after: "legacy-sha" });
    await dbQuery(
      "INSERT INTO webhook_events (source, event_id, type, payload) VALUES ('github', 'legacy-delivery-7', 'push', $1::jsonb)",
      [JSON.stringify({ repo: "o/legacy", ref: "refs/heads/main", after: "legacy-sha" })],
    );
    const legacyReplay = await req("POST", "/webhooks/github", {
      raw: oldBody,
      headers: { ...hdr, "x-github-delivery": "brand-new-id", "x-hub-signature-256": "sha256=" + hmacHex(GITHUB_SECRET, oldBody) },
    });
    expect(legacyReplay.json).toEqual({ received: true, replay: true });
    const sameId = await req("POST", "/webhooks/github", {
      raw: JSON.stringify({ zen: "ping" }),
      headers: { ...hdr, "x-github-event": "ping", "x-github-delivery": "legacy-delivery-7", "x-hub-signature-256": "sha256=" + hmacHex(GITHUB_SECRET, JSON.stringify({ zen: "ping" })) },
    });
    expect(sameId.json).toEqual({ received: true, replay: true });
  });

  test("brain + mesh HMAC; railway token; stripe unarmed", async () => {
    const b = JSON.stringify({ id: "b1", type: "ping", data: { x: 1 } });
    expect((await req("POST", "/webhooks/brain", { raw: b, headers: { "x-brain-signature": "nope" } })).status).toBe(401);
    expect((await req("POST", "/webhooks/brain", { raw: b, headers: { "x-brain-signature": hmacHex(BRAIN_SECRET, b) } })).json).toEqual({ received: true });
    expect((await req("POST", "/webhooks/brain", { raw: b, headers: { "x-brain-signature": hmacHex(BRAIN_SECRET, b) } })).json.replay).toBe(true);

    const m = JSON.stringify({ receipt_id: "r1", amount: 3, capability: "x" });
    expect((await req("POST", "/webhooks/mesh", { raw: m, headers: { "x-mesh-signature": "bad" } })).status).toBe(401);
    const mo = await req("POST", "/webhooks/mesh", { raw: m, headers: { "x-mesh-signature": hmacHex(MESH_SECRET, m) } });
    expect(mo.status).toBe(202);
    expect(mo.json.minted).toBe(false);

    const rw = { type: "DEPLOY", timestamp: "2026-01-01", resource: { service: { id: "svc-none" } } };
    expect((await req("POST", "/webhooks/railway", { body: rw, headers: { "x-runtime-token": "wrong" } })).status).toBe(401);
    // 2026-09-25: Railway project webhooks send no custom headers and are not
    // cryptographically signed -- Railway's own docs say to put the secret in
    // the URL (docs.railway.com/observability/webhooks#verifying-the-sender).
    // Header-only auth (the earlier same-day change this reverts, for this
    // route alone) would make every Railway project webhook unauthenticatable,
    // so the query fallback is back. A different payload than `rw`, or this
    // would collide with `ro` below on the idempotency key and come back a
    // replay instead of a fresh result.
    const rwQuery = { type: "DEPLOY", timestamp: "2026-01-02", resource: { service: { id: "svc-query" } } };
    const queryOnly = await req("POST", "/webhooks/railway?token=" + RAILWAY_TOKEN, { body: rwQuery });
    expect(queryOnly.json).toEqual({ received: true, result: { matched: 0, status: "deploy" } });
    const wrongQuery = await req("POST", "/webhooks/railway?token=nope", { body: rw });
    expect(wrongQuery.status).toBe(401);
    expect(wrongQuery.json.error).toBe("bad_token");
    const ro = await req("POST", "/webhooks/railway", { body: rw, headers: { "x-runtime-token": RAILWAY_TOKEN } });
    expect(ro.json).toEqual({ received: true, result: { matched: 0, status: "deploy" } });

    const s = await req("POST", "/webhooks/stripe", { raw: "{}" });
    expect(s.status).toBe(503);
    expect(s.json.detail).toEqual({ needs: "STRIPE_WEBHOOK_SECRET" });
  });

  // 2026-09-25: the query token exists ONLY because Railway can't carry a
  // header. It must never end up somewhere it could leak the same way a URL
  // fallback already does (access/proxy/Railway request logs) -- this app's
  // OWN logs, on a request that errors, must not carry it either.
  test("the railway webhook token in ?token= never reaches a log line, even when the request errors", async () => {
    const logged = [];
    const originalError = console.error;
    console.error = (...a) => logged.push(a.map(String).join(" "));
    let r;
    try {
      // A non-string service id: handleRailwayEvent binds it straight into
      // `WHERE railway_service_id = $1` against a TEXT column with no
      // String(...) in between -- a genuine 500 from the database, not a
      // crafted one, so the error handler's log line is the real path.
      const bad = { type: "DEPLOY", timestamp: "2026-09-25T00:00:00Z", resource: { service: { id: 424242 } } };
      r = await req("POST", "/webhooks/railway?token=" + RAILWAY_TOKEN, { body: bad });
    } finally {
      console.error = originalError;
    }
    expect(r.status).toBe(500);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(RAILWAY_TOKEN);
      expect(line.toLowerCase()).not.toContain("token=");
    }
  });
});

// ------------------------------------------------------------------------------------
describe("7. rate limit", () => {
  test(`exceeding RATE_LIMIT_PER_MIN (${RATE_LIMIT}) for one grant -> 429`, async () => {
    const t = await newTenant("rate-tenant");
    const other = await newTenant("rate-other");
    let last;
    for (let i = 0; i < RATE_LIMIT; i++) {
      last = await req("GET", "/api/grants/verify", { token: t.token });
      expect(last.status).toBe(200);
    }
    last = await req("GET", "/api/grants/verify", { token: t.token });
    expect(last.status).toBe(429);
    expect(last.json.error).toBe("rate_limited");
    // per grant: another grant is unaffected
    expect((await req("GET", "/api/grants/verify", { token: other.token })).status).toBe(200);
    // admin is not grant-rate-limited
    expect((await admin("GET", "/api/admin/policy")).json.rateLimitPerMin).toBe(RATE_LIMIT);
  });

  // 2026-09-25: /mcp verifies the grant TWICE per call (a pre-check before the
  // JSON-RPC method is known, then again for the tool's specific capability).
  // Both calls used to count against the budget, so one MCP tool call cost
  // TWICE what the same action costs over REST.
  //
  // "runtime_health" does NOT exercise this: src/routes/mcp.js answers it at
  // line ~101, before the "unknown_tool" capability map (line ~115) and the
  // second verifyGrant call (line ~140) are ever reached -- so a test that
  // calls it only ever exercises the first, pre-check verifyGrant, pass or
  // fail, on both the buggy and the fixed line. "grant_verify" routes through
  // both calls, so it actually proves the fix.
  test(`a single MCP tools/call spends exactly one rate-limit unit, matching REST`, async () => {
    const t = await newTenant("mcp-rate-tenant");
    let last;
    for (let i = 0; i < RATE_LIMIT; i++) {
      last = await mcp(t.token, "tools/call", { name: "grant_verify" }, i);
      expect(last.status).toBe(200);
      expect(last.json.result.isError).toBeUndefined();
    }
    last = await mcp(t.token, "tools/call", { name: "grant_verify" }, RATE_LIMIT);
    expect(last.status).toBe(429);
    expect(last.json.error).toBe("rate_limited");
  });

  // 2026-09-25: the bucket used to be a process-local Map — invisible to, and
  // reset independently by, every other replica. It now lives in Postgres.
  test("rate-limit counters are Postgres-backed, not process-local state", async () => {
    const t = await newTenant("db-rate-tenant");
    await req("GET", "/api/grants/verify", { token: t.token });
    await req("GET", "/api/grants/verify", { token: t.token });
    await req("GET", "/api/grants/verify", { token: t.token });
    const rows = await dbQuery("SELECT count FROM rate_limits WHERE grant_id = $1", [t.grantId]);
    expect(rows.rows.length).toBe(1);
    expect(Number(rows.rows[0].count)).toBe(3);
  });
});

// ------------------------------------------------------------------------------------
describe("7b. memory partition scope is a real prefix, not a bare string match", () => {
  // 2026-09-25: `t.startsWith(a)` let a grant scoped to partition "worker:a"
  // (or an OAuth profile scoped to "product:devdesk") also reach "worker:ab"
  // / "product:devdesktop" — a different worker/product with no separator
  // between them. Fixed via policy.js `partitionCovers`.
  test("a scope prefix does not reach a same-prefixed but different partition", async () => {
    const t = await newTenant("prefix-tenant");
    const child = await req("POST", "/api/grants", {
      token: t.token,
      body: {
        sub: "agent:scoped", caps: ["memory.read", "memory.write"], ttlSec: 600,
        scope: { memory: { partitions: ["worker:a"] } },
      },
    });
    expect(child.status).toBe(201);
    const inScope = await req("POST", "/api/memory", { token: child.json.token, body: { partition: "worker:a", content: "ok" } });
    expect(inScope.status).toBe(201);
    // "worker:ab" starts with "worker:a" but is a DIFFERENT worker's partition.
    const collide = await req("POST", "/api/memory", { token: child.json.token, body: { partition: "worker:ab", content: "should not be reachable" } });
    expect(collide.status).toBe(403);
    expect(collide.json.error).toBe("out_of_scope");
    // A real sub-partition (separator right after the prefix) still works.
    const nested = await req("POST", "/api/memory", { token: child.json.token, body: { partition: "worker:a-shard1", content: "nested ok" } });
    expect(nested.status).toBe(201);
  });
});

// ------------------------------------------------------------------------------------
describe("8. extras: grants, deploys, cog, docs, status", () => {
  test("child grant attenuation: widening refused, subtree revoke", async () => {
    const t = await newTenant("grant-tenant");
    const widened = await req("POST", "/api/grants", { token: t.token, body: { caps: ["memory.read"], budget: { usd_cents: 999999 } } });
    expect(widened.status).toBe(403);
    expect(widened.json).toEqual({ error: "attenuation_violation", detail: ["budget_exceeds_parent_remaining"] });
    const unknownCap = await req("POST", "/api/grants", { token: t.token, body: { caps: ["money.move"] } });
    expect(unknownCap.status).toBe(403);
    expect(unknownCap.json.detail).toContain("unknown_cap:money.move");
    const c = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:c", caps: ["grant.read", "grant.issue"], ttlSec: 600, budget: { usd_cents: 10, calls: 5 } } });
    expect(c.status).toBe(201);
    const gc = await req("POST", "/api/grants", { token: c.json.token, body: { sub: "agent:gc", caps: ["grant.read"], ttlSec: 300 } });
    expect(gc.status).toBe(201);
    const list = await req("GET", "/api/grants", { token: t.token });
    expect(list.json.grants.length).toBe(3);
    const rv = await req("POST", `/api/grants/${c.json.id}/revoke`, { token: t.token, body: {} });
    expect(rv.json.revoked.sort()).toEqual([c.json.id, gc.json.id].sort());
    expect((await req("GET", "/api/grants/verify", { token: gc.json.token })).status).toBe(401);
  });

  test("deploy is a dry run by default (no outbound)", async () => {
    const t = await newTenant("deploy-tenant");
    const v = await req("GET", "/api/grants/verify", { token: t.token });
    const name = v.json.scope.workers.namePrefix + "probe-1";
    const d = await req("POST", "/api/deploys", { token: t.token, body: { name, template: "probe" } });
    expect(d.status).toBe(201);
    expect(d.json.status).toBe("dry_run");
    expect(d.json.executed).toBe(false);
    expect(d.json.reason).toBe("dry_run");
    const bad = await req("POST", "/api/deploys", { token: t.token, body: { name: "x", template: "probe" } });
    expect(bad.json.error).toBe("bad_worker_name");
  });

  test("cog plan is deterministic without ANTHROPIC_API_KEY", async () => {
    const t = await newTenant("cog-tenant");
    const p = await req("POST", "/api/cog/plan", { token: t.token, body: { intent: "send tip alerts to discord" } });
    expect(p.status).toBe(200);
    expect(p.json.proposal.template).toBe("tip-alert-bot");
    expect(p.json.proposal.planner).toBe("deterministic");
    const g = mod.gatehouseEvaluate({ id: t.id, status: "active", tier: "starter", allowed_targets: {} }, null, p.json.proposal);
    expect(g).toEqual({ ok: true, reasons: [] });
  });

  test("docs: admin PUT, public GET, underscore docs hidden", async () => {
    expect((await req("PUT", "/api/admin/docs/guide", { raw: "# Hi" })).status).toBe(401);
    expect((await admin("PUT", "/api/admin/docs/guide", { raw: "# Hi\n\n`code`" })).json).toEqual({ ok: true, name: "guide", bytes: 12 });
    const html = await req("GET", "/docs/guide");
    expect(html.text).toContain("<h1>Hi</h1>");
    expect((await req("GET", "/docs/guide?raw")).text).toBe("# Hi\n\n`code`");
    await admin("PUT", "/api/admin/docs/_cockpit", { raw: "<p>cockpit</p>" });
    expect((await req("GET", "/")).text).toBe("<p>cockpit</p>");
    expect((await req("GET", "/docs/_cockpit")).status).toBe(404);
  });

  // 2026-09-25: markdownToHtml only escaped fenced/inline code content. A
  // heading, paragraph, list item or table cell carrying raw "<...>" rendered
  // as a live tag to every unauthenticated viewer of /docs/:name — stored XSS
  // from an admin-written (or admin-ingested) doc.
  test("docs: heading/paragraph/list/table text is HTML-escaped, not just code spans", async () => {
    const src = [
      "# <script>alert(1)</script>",
      "",
      "Hi <img src=x onerror=alert(2)> there **<b>bold</b>** and `<i>code</i>`",
      "",
      "- <u>item</u>",
      "",
      "| <em>a</em> | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    await admin("PUT", "/api/admin/docs/xss", { raw: src });
    const html = (await req("GET", "/docs/xss")).text;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).not.toContain("<u>item</u>");
    expect(html).not.toContain("<em>a</em>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    // the two intentional transforms (code spans, **bold**) still work
    expect(html).toContain("<code>&lt;i&gt;code&lt;/i&gt;</code>");
    expect(html).toContain("<b>&lt;b&gt;bold&lt;/b&gt;</b>");
    // raw markdown source (?raw) is untouched either way
    expect((await req("GET", "/docs/xss?raw")).text).toBe(src);
  });

  test("status report runs; every outbound call was blocked and is a known probe", async () => {
    const s = await req("GET", "/status.json");
    expect(s.status).toBe(200);
    expect(s.json.version).toBe("0.3.4");
    expect(s.json.bodies.map((b) => b.up)).toEqual([false, false, false]);
    const allowed = new Set([
      "https://devdesk.meshtool.ai/health", "https://market.meshtool.ai/api/health",
      "https://mcp-gate-production.up.railway.app/health", "https://devdesk.meshtool.ai/runtime/status",
    ]);
    expect(blockedFetches.length).toBeGreaterThan(0);
    for (const u of blockedFetches) expect(allowed.has(u)).toBe(true);
    // 2026-09-25: public status is cached — hammering it makes no new probes.
    const before = blockedFetches.length;
    await Promise.all(Array.from({ length: 10 }, () => req("GET", "/status.json")));
    await req("GET", "/status");
    expect(blockedFetches.length).toBe(before);
  });
});

// ------------------------------------------------------------------------------------
// 0.3.2: no code-write / deploy grant signs until lsp-mcp diagnostics come back clean.
describe("9. diagnostics gate (lsp-mcp, 0.3.2)", () => {
  const CLEAN = [{ path: "src/ok.ts", content: "export const n: number = 1;\n" }];
  const BROKEN = [{ path: "src/x.ts", content: "let BROKEN: string = 1;\n" }];
  const WARN = [{ path: "src/w.ts", content: "let WARN = 1;\n" }];
  async function plan(t) {
    const p = await req("POST", "/api/cog/plan", { token: t.token, body: { intent: "send tip alerts to discord" } });
    expect(p.status).toBe(200);
    return p.json.proposal;
  }
  const exec = (t, proposal) => req("POST", "/api/cog/execute", { token: t.token, body: { proposal } });

  test("root grants carry the five new caps; lsp.* grants are issuable with a short TTL", async () => {
    const t = await newTenant("lsp-caps");
    const v = await req("GET", "/api/grants/verify", { token: t.token });
    for (const c of ["code.write", "lsp.diagnose", "lsp.hover", "lsp.definition", "lsp.references"]) expect(v.json.caps).toContain(c);
    const g = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:reviewer", caps: ["lsp.diagnose", "lsp.hover"], ttlSec: 120, budget: { calls: 20 } } });
    expect(g.status).toBe(201);
    expect(g.json.caps).toEqual(["lsp.diagnose", "lsp.hover"]);
    expect(g.json.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120);
  });

  test("a proposal with a file that has a type error is refused at sign time, diagnostic in the reason", async () => {
    const t = await newTenant("lsp-broken");
    const before = lsp.calls.length;
    const r = await exec(t, { ...(await plan(t)), files: BROKEN });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("gatehouse_denied");
    expect(r.json.detail).toEqual(["diagnostic_error:src/x.ts:2:5:Type 'number' is not assignable to type 'string'."]);
    expect(lsp.calls.length).toBe(before + 1);
    expect(lsp.calls.at(-1).files).toEqual(["src/x.ts"]);
    // lsp-mcp saw an ephemeral least-privilege hop grant, not the caller's token.
    expect(lsp.calls.at(-1).token).not.toBe(t.token);
    const ev = await req("GET", "/api/events", { token: t.token });
    const denied = ev.json.events.find((e) => e.type === "cog.denied");
    expect(denied.data.reasons[0]).toStartWith("diagnostic_error:src/x.ts:2:5:");
    // Nothing was signed: the only child is the hop grant, already revoked; no deploy.
    const grants = (await req("GET", "/api/grants", { token: t.token })).json.grants;
    expect(grants.filter((g) => g.status === "active").length).toBe(1);
    const hop = grants.find((g) => g.parent === t.grantId);
    expect(hop.status).toBe("revoked");
    expect(hop.caps).toEqual(["lsp.diagnose"]);
    expect(hop.sub).toBe("tenant:root:lsp");
    expect((await req("GET", "/api/deploys", { token: t.token })).json.deploys.length).toBe(0);
  });

  test("the same proposal with clean files signs normally and reports the diagnostics summary", async () => {
    const t = await newTenant("lsp-clean");
    const r = await exec(t, { ...(await plan(t)), files: CLEAN });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.grants)).toEqual(["deployer"]);
    expect(r.json.deploys[0].status).toBe("dry_run");
    expect(r.json.diagnostics.summary).toEqual({ errors: 0, warnings: 0, informations: 0, hints: 0 });
    expect(r.json.diagnostics.filesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.diagnostics.backend).toBe("typescript");
  });

  test("a proposal with no files is the existing flow: lsp-mcp is not called, nothing changes", async () => {
    const t = await newTenant("lsp-nofiles");
    const before = lsp.calls.length;
    const r = await exec(t, await plan(t));
    expect(r.status).toBe(200);
    expect(r.json.diagnostics).toBeUndefined();
    expect(lsp.calls.length).toBe(before);
  });

  test("warnings do not block; they are logged as an event", async () => {
    const t = await newTenant("lsp-warn");
    const r = await exec(t, { ...(await plan(t)), files: WARN });
    expect(r.status).toBe(200);
    expect(r.json.diagnostics.summary.warnings).toBe(1);
    const ev = await req("GET", "/api/events", { token: t.token });
    const w = ev.json.events.find((e) => e.type === "cog.diagnostics.warnings");
    expect(w.data.warnings).toEqual(["src/w.ts:1:1:'x' is declared but never used."]);
  });

  test("caller-attached diagnostics are ignored: the gatehouse only trusts what it fetched itself", async () => {
    const t = await newTenant("lsp-forged");
    const forged = { filesSha256: "0".repeat(64), files: [{ path: "src/x.ts", diagnostics: [] }], summary: { errors: 0 } };
    const r = await exec(t, { ...(await plan(t)), files: BROKEN, diagnostics: forged });
    expect(r.status).toBe(403);
    expect(r.json.detail[0]).toStartWith("diagnostic_error:src/x.ts:2:5:");
  });

  test("caller grant without lsp.diagnose: lsp-mcp refuses it and so does the gatehouse (no bypass)", async () => {
    const t = await newTenant("lsp-nocap");
    const child = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:builder", caps: ["grant.issue", "cog.plan", "cog.execute", "deploy.worker", "worker.status", "memory.read", "memory.write"], ttlSec: 600, budget: { usd_cents: 200, calls: 50, deploys: 2 } },
    });
    expect(child.status).toBe(201);
    const p = await req("POST", "/api/cog/plan", { token: child.json.token, body: { intent: "send tip alerts to discord" } });
    const r = await req("POST", "/api/cog/execute", { token: child.json.token, body: { proposal: { ...p.json.proposal, files: CLEAN } } });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "gatehouse_denied", detail: ["diagnostics_refused:missing_cap"] });
  });

  test("lsp-mcp down or unconfigured: a proposal with files is refused, never waved through", async () => {
    const t = await newTenant("lsp-down");
    const proposal = { ...(await plan(t)), files: CLEAN };
    lsp.mode = "down";
    try {
      const r = await exec(t, proposal);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: "gatehouse_denied", detail: ["diagnostics_unavailable:unreachable"] });
    } finally { lsp.mode = "ok"; }
    const url = process.env.LSP_MCP_URL;
    delete process.env.LSP_MCP_URL;
    try {
      expect((await req("GET", "/health")).json.armed.lspMcp).toBe(false);
      const r = await exec(t, proposal);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: "gatehouse_denied", detail: ["diagnostics_unavailable:LSP_MCP_URL"] });
    } finally { process.env.LSP_MCP_URL = url; }
    lsp.mode = "broke";
    try {
      const r = await exec(t, proposal);
      expect(r.status).toBe(403);
      expect(r.json.detail).toEqual(["diagnostics_refused:budget_exhausted"]);
    } finally { lsp.mode = "ok"; }
  });

  test("bad overlay entries are refused before lsp-mcp is called", async () => {
    const t = await newTenant("lsp-badfiles");
    const before = lsp.calls.length;
    const proposal = await plan(t);
    for (const files of [[{ path: "../x.ts", content: "" }], [{ path: "C:/x.ts", content: "" }], [{ path: "a.ts" }], [{ path: "a.ts", content: "" }, { path: "a.ts", content: "" }]]) {
      const r = await exec(t, { ...proposal, files });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("gatehouse_denied");
      expect(r.json.detail[0]).toMatch(/^(bad_path|bad_file_entry|duplicate_path):/);
    }
    expect(lsp.calls.length).toBe(before);
  });

  test("pure gatehouseEvaluate: code.write needs files; files need fresh, clean diagnostics", () => {
    const tenant = { id: "t", status: "active", tier: "starter", allowed_targets: {} };
    const grant = (caps) => ({ key: "w", sub: "agent:w", caps, ttlSec: 600, budget: { usd_cents: 10, calls: 5, deploys: 0 }, scope: {}, constraints: {} });
    const ev = (p) => mod.gatehouseEvaluate(tenant, null, p).reasons;
    expect(ev({ grants: [grant(["code.write"])], deploys: [] })).toEqual(["code_write_requires_files"]);
    expect(ev({ grants: [grant(["code.write"])], deploys: [], files: CLEAN })).toEqual(["diagnostics_missing"]);
    expect(ev({ grants: [grant(["code.write"])], deploys: [], files: CLEAN, diagnostics: { filesSha256: "nope", files: [] } })).toEqual(["diagnostics_stale"]);
    const h = overlayHash(CLEAN);
    // A result that lists no file diagnosed nothing: code.write refuses it.
    expect(ev({ grants: [grant(["code.write"])], deploys: [], files: CLEAN, diagnostics: { filesSha256: h, files: [] } })).toEqual(["file_not_diagnosed:src/ok.ts"]);
    expect(ev({ grants: [grant(["code.write"])], deploys: [], files: CLEAN, diagnostics: { filesSha256: h, files: [{ path: "src/ok.ts", diagnostics: [] }] } })).toEqual([]);
    expect(ev({ grants: [grant(["code.write"])], deploys: [], files: CLEAN, diagnostics: { filesSha256: h, files: [{ path: "src/ok.ts", diagnostics: [{ severity: "error", line: 0, col: 2, message: "boom\nmore" }] }] } }))
      .toEqual(["diagnostic_error:src/ok.ts:1:3:boom"]);
    expect(ev({ grants: [grant(["code.write"])], deploys: [], files: CLEAN, diagnostics: { filesSha256: h, files: [{ path: "src/ok.ts", diagnostics: [{ severity: "warning", line: 0, col: 2, message: "meh" }] }] } })).toEqual([]);
    // Files on a proposal that signs neither code.write nor a deploy are not gated.
    expect(ev({ grants: [grant(["memory.read"])], deploys: [], files: CLEAN })).toEqual([]);
    // A deploy with files is gated even without code.write.
    expect(ev({ grants: [grant(["deploy.worker"])], deploys: [], files: CLEAN })).toEqual(["diagnostics_missing"]);
  });

  test("POST /api/grants/settle: a holder charges its own budget; 402 when it is gone; 401 without a grant", async () => {
    const t = await newTenant("settle");
    const c = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:lsp", caps: ["lsp.diagnose"], ttlSec: 120, budget: { calls: 2 } } });
    expect(c.status).toBe(201);
    const s1 = await req("POST", "/api/grants/settle", { token: c.json.token, body: { calls: 1, ref: "lsp:diagnose", note: "lsp.diagnose 1 file(s)" } });
    expect(s1.status).toBe(200);
    expect(s1.json.settled).toEqual({ usd_cents: 0, calls: 1, deploys: 0 });
    expect(s1.json.remaining.calls).toBe(1);
    expect((await req("POST", "/api/grants/settle", { token: c.json.token, body: { calls: 1 } })).json.remaining.calls).toBe(0);
    const s3 = await req("POST", "/api/grants/settle", { token: c.json.token, body: { calls: 1 } });
    expect(s3.status).toBe(402);
    expect(s3.json.error).toBe("budget_exhausted");
    expect((await req("POST", "/api/grants/settle", { token: c.json.token, body: {} })).json.error).toBe("nothing_to_settle");
    expect((await req("POST", "/api/grants/settle", { body: { calls: 1 } })).status).toBe(401);
    const led = await req("GET", "/api/ledger", { token: t.token });
    expect(led.json.ledger.filter((l) => l.kind === "self-settle" && l.grant_id === c.json.id).map((l) => l.ref)).toEqual(["self", "lsp:diagnose"]);
    expect(led.json.ledger.filter((l) => l.kind === "settle" && l.grant_id === c.json.id).length).toBe(0);
  });
});

// ------------------------------------------------------------------------------------
// 0.3.2 review round: the gate is a control, not a checkbox.
describe("10. diagnostics gate — binding, no side doors, settle in the loop", () => {
  const CLEAN = [{ path: "src/ok.ts", content: "export const n: number = 1;\n" }];
  const BROKEN = [{ path: "src/x.ts", content: "let BROKEN: string = 1;\n" }];
  const writer = { key: "writer", sub: "agent:writer", caps: ["code.write", "memory.read"], ttlSec: 600, budget: { usd_cents: 0, calls: 5, deploys: 0 } };

  test("code.write cannot be issued through the direct grant routes (REST or MCP): no diagnostics, no grant", async () => {
    const t = await newTenant("cw-direct");
    const rest = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:sneak", caps: ["code.write"], ttlSec: 600 } });
    expect(rest.status).toBe(403);
    expect(rest.json).toEqual({ error: "attenuation_violation", detail: ["code_write_requires_diagnostics"] });
    const m = await mcp(t.token, "tools/call", { name: "grant_issue", arguments: { sub: "agent:sneak", caps: ["code.write"], ttlSec: 600 } });
    expect(m.status).toBe(403);
    expect(m.json.error).toBe("attenuation_violation");
    expect((await req("GET", "/api/grants", { token: t.token })).json.grants.length).toBe(1);
  });

  test("a code.write grant issued by the COG carries the diagnosed hash in scope.code; the event records it; the ledger shows lsp settled", async () => {
    const t = await newTenant("cw-bound");
    const r = await exec(t, { grants: [writer], deploys: [], files: CLEAN });
    expect(r.status).toBe(200);
    const id = r.json.grants.writer.id;
    const g = await req("GET", `/api/grants/${id}`, { token: t.token });
    expect(g.json.grant.scope.code).toEqual({ filesSha256: r.json.diagnostics.filesSha256 });
    expect(g.json.grant.caps).toEqual(["code.write", "memory.read"]);
    const ev = await req("GET", "/api/events", { token: t.token });
    expect(ev.json.events.find((e) => e.type === "cog.executed").data.filesSha256).toBe(r.json.diagnostics.filesSha256);
    const led = await req("GET", "/api/ledger", { token: t.token });
    const settle = led.json.ledger.find((l) => l.kind === "self-settle" && l.ref === "lsp:diagnose");
    expect(settle.parent).toBe(t.grantId); // charged on the ephemeral hop grant, reserved from the caller
    expect(settle.calls).toBe(1);
    const hop = (await req("GET", "/api/grants", { token: t.token })).json.grants.find((g) => g.id === settle.grant_id);
    expect(hop.status).toBe("revoked");
    // and the grant token itself carries no hash-free code.write
    const v = await req("GET", "/api/grants/verify", { token: r.json.grants.writer.token });
    expect(v.json.scope.code.filesSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a code.write proposal with a broken file signs nothing", async () => {
    const t = await newTenant("cw-broken");
    const r = await exec(t, { grants: [writer], deploys: [], files: BROKEN });
    expect(r.status).toBe(403);
    expect(r.json.detail[0]).toStartWith("diagnostic_error:src/x.ts:2:5:");
    expect((await req("GET", "/api/grants", { token: t.token })).json.grants.filter((g) => g.status === "active").length).toBe(1);
  });

  test("no files + forged diagnostics: nothing is reflected back as if the runtime produced it", async () => {
    const t = await newTenant("cw-reflect");
    const p = await req("POST", "/api/cog/plan", { token: t.token, body: { intent: "send tip alerts to discord" } });
    const r = await exec(t, { ...p.json.proposal, diagnostics: { filesSha256: "f".repeat(64), summary: { errors: 0 }, backend: "forged" } });
    expect(r.status).toBe(200);
    expect(r.json.diagnostics).toBeUndefined();
  });

  test("lsp-mcp slower than LSP_MCP_TIMEOUT_MS: refused as unavailable, no grant, no deploy", async () => {
    const t = await newTenant("cw-slow");
    lsp.mode = "slow";
    process.env.LSP_MCP_TIMEOUT_MS = "600";
    try {
      const r = await exec(t, { grants: [writer], deploys: [], files: CLEAN });
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: "gatehouse_denied", detail: ["diagnostics_unavailable:unreachable"] });
    } finally {
      lsp.mode = "ok";
      delete process.env.LSP_MCP_TIMEOUT_MS;
    }
    expect((await req("GET", "/api/grants", { token: t.token })).json.grants.filter((g) => g.status === "active").length).toBe(1);
    expect(mod.default.idleTimeout).toBe(255);
  });

  test("a plan budgeted before the lsp charge still issues: budgets are clamped to what remains", async () => {
    const t = await newTenant("cw-clamp");
    // A tight caller grant: 3 calls. lsp-mcp takes 1; the child asks for 3.
    const tight = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:tight", caps: ["grant.issue", "cog.execute", "lsp.diagnose", "memory.read"], ttlSec: 600, budget: { calls: 3 } } });
    expect(tight.status).toBe(201);
    const r = await req("POST", "/api/cog/execute", {
      token: tight.json.token,
      body: { proposal: { grants: [{ key: "m", sub: "agent:m", caps: ["memory.read"], ttlSec: 300, budget: { calls: 3 } }], deploys: [], files: CLEAN } },
    });
    expect(r.status).toBe(200);
    const child = await req("GET", `/api/grants/${r.json.grants.m.id}`, { token: t.token });
    expect(child.json.grant.budget.calls).toBe(2);
  });

  test("POST /api/grants/settle rejects non-object bodies and odd refs", async () => {
    const t = await newTenant("settle-shape");
    expect((await req("POST", "/api/grants/settle", { token: t.token, raw: "[1]", headers: { "content-type": "application/json" } })).json.error).toBe("bad_body");
    expect((await req("POST", "/api/grants/settle", { token: t.token, raw: "1", headers: { "content-type": "application/json" } })).json.error).toBe("bad_body");
    expect((await req("POST", "/api/grants/settle", { token: t.token, body: { calls: 1, ref: "dep_1 OR 1=1" } })).json.error).toBe("bad_ref");
  });

  const exec = (t, proposal) => req("POST", "/api/cog/execute", { token: t.token, body: { proposal } });
});

// ------------------------------------------------------------------------------------
// 0.3.2 refute round: the canon is injective, the hop is least-privilege, self-settle is calls only.
describe("11. diagnostics gate — refute round", () => {
  const CLEAN = [{ path: "src/ok.ts", content: "export const n: number = 1;\n" }];
  const writer = { key: "writer", sub: "agent:writer", caps: ["code.write", "memory.read"], ttlSec: 600, budget: { usd_cents: 0, calls: 5, deploys: 0 } };
  const exec = (t, proposal) => req("POST", "/api/cog/execute", { token: t.token, body: { proposal } });

  test("NUL in content cannot fake a file boundary: refused before lsp-mcp, and the canon is length-prefixed", async () => {
    const t = await newTenant("canon");
    const before = lsp.calls.length;
    const r = await exec(t, { grants: [writer], deploys: [], files: [{ path: "a.ts", content: "// ok\0evil.ts\0export const pwn = 1;" }] });
    expect(r.status).toBe(403);
    expect(r.json.detail).toEqual(["bad_file_entry:a.ts"]);
    expect(lsp.calls.length).toBe(before);
    expect(overlayHash([{ path: "a.ts", content: "// ok" }, { path: "evil.ts", content: "export const pwn = 1;" }]))
      .not.toBe(overlayHash([{ path: "a.ts", content: "// ok\0evil.ts\0export const pwn = 1;" }]));
    // Path charset is the same as lsp-mcp's.
    const r2 = await exec(t, { grants: [writer], deploys: [], files: [{ path: 'x"]#[path="/etc/passwd"].rs', content: "" }] });
    expect(r2.json.detail[0]).toStartWith("bad_path:");
  });

  test("code.write: a file no backend diagnosed cannot ride on a clean attestation", async () => {
    const t = await newTenant("undiagnosed");
    // The fake lsp-mcp reports only what it was sent; here it reports both, so make one report nothing.
    const r = await exec(t, { grants: [writer], deploys: [], files: [...CLEAN, { path: "notes.md", content: "# hi" }] });
    // fake returns a diagnostics array for every file, so this signs; the pure check is what refuses an omission:
    expect(r.status).toBe(200);
    const h = overlayHash([...CLEAN, { path: "notes.md", content: "# hi" }].sort((a, b) => (a.path < b.path ? -1 : 1)));
    const tenant = { id: "t", status: "active", tier: "starter", allowed_targets: {} };
    const ev = mod.gatehouseEvaluate(tenant, null, {
      grants: [writer], deploys: [], files: [...CLEAN, { path: "notes.md", content: "# hi" }],
      diagnostics: { filesSha256: h, files: [{ path: "src/ok.ts", diagnostics: [] }] },
    });
    expect(ev.reasons).toEqual(["file_not_diagnosed:notes.md"]);
  });

  test("the hop grant is least privilege and short: lsp.diagnose only, one call, revoked after; the caller keeps its budget minus one", async () => {
    const t = await newTenant("hop");
    const before = (await req("GET", "/api/grants/verify", { token: t.token })).json.remaining;
    const r = await exec(t, { grants: [writer], deploys: [], files: CLEAN });
    expect(r.status).toBe(200);
    const grants = (await req("GET", "/api/grants", { token: t.token })).json.grants;
    const hop = grants.find((g) => g.sub === "tenant:root:lsp");
    expect(hop.status).toBe("revoked");
    expect(hop.caps).toEqual(["lsp.diagnose"]);
    expect(hop.budget).toEqual({ usd_cents: 0, calls: 1, deploys: 0 });
    expect(hop.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    const after = (await req("GET", "/api/grants/verify", { token: t.token })).json.remaining;
    // one call for the hop, plus the writer grant's own reserve (5 calls)
    expect(before.calls - after.calls).toBe(1 + 5);
    expect(before.usd_cents - after.usd_cents).toBe(0);
  });

  test("a caller that cannot mint the hop presents its own token (still gated, still works)", async () => {
    const t = await newTenant("nohop");
    const c = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:solo", caps: ["cog.execute", "lsp.diagnose", "memory.read"], ttlSec: 600, budget: { calls: 10 } } });
    expect(c.status).toBe(201);
    const r = await req("POST", "/api/cog/execute", { token: c.json.token, body: { proposal: { grants: [], deploys: [], files: CLEAN } } });
    expect(r.status).toBe(200);
    expect(lsp.calls.at(-1).token).toBe(c.json.token);
  });

  test("LSP_MCP_URL must be https or private: an http public URL never receives a token", async () => {
    const t = await newTenant("insecure");
    const url = process.env.LSP_MCP_URL;
    process.env.LSP_MCP_URL = "http://example.com";
    const before = blockedFetches.length;
    try {
      const r = await exec(t, { grants: [writer], deploys: [], files: CLEAN });
      expect(r.status).toBe(403);
      expect(r.json.detail).toEqual(["diagnostics_unavailable:insecure_url"]);
    } finally { process.env.LSP_MCP_URL = url; }
    expect(blockedFetches.length).toBe(before);
  });

  test("self-settle is calls only and lands as kind self-settle, never as a deploy charge", async () => {
    const t = await newTenant("selfsettle");
    const bad = await req("POST", "/api/grants/settle", { token: t.token, body: { calls: 1, usd_cents: 25, deploys: 1, ref: "dp_a1b2c3d4e5f6", note: "deploy t-abc123-probe-1" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("calls_only");
    const ok = await req("POST", "/api/grants/settle", { token: t.token, body: { calls: 1, ref: "dp_a1b2c3d4e5f6", note: "deploy t-abc123-probe-1" } });
    expect(ok.status).toBe(200);
    const led = await req("GET", "/api/ledger", { token: t.token });
    const row = led.json.ledger.find((l) => l.ref === "dp_a1b2c3d4e5f6");
    expect(row.kind).toBe("self-settle");
    expect(row.usd_cents).toBe(0);
    expect(row.deploys).toBe(0);
  });

  test("the calls clamp never rescues a usd/deploys shortfall: that stays a clean refusal with nothing issued", async () => {
    const t = await newTenant("noclamp");
    const tight = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:tight", caps: ["grant.issue", "cog.plan", "cog.execute", "lsp.diagnose", "deploy.worker", "worker.status", "memory.read", "memory.write"], ttlSec: 600, budget: { usd_cents: 100, calls: 20, deploys: 0 } } });
    expect(tight.status).toBe(201);
    const p = await req("POST", "/api/cog/plan", { token: tight.json.token, body: { intent: "send tip alerts to discord" } });
    const proposal = { ...p.json.proposal, files: CLEAN };
    proposal.grants[0].budget.deploys = 1; // asks for a deploy the caller cannot fund
    const r = await req("POST", "/api/cog/execute", { token: tight.json.token, body: { proposal } });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "attenuation_violation", detail: ["budget_exceeds_parent_remaining"] });
    // root + tight are the only live grants; the hop is revoked and nothing else was issued
    const all = (await req("GET", "/api/grants", { token: t.token })).json.grants;
    expect(all.filter((g) => g.status === "active").map((g) => g.sub).sort()).toEqual(["agent:tight", "tenant:root"]);
    expect(all.find((g) => g.parent === tight.json.id).status).toBe("revoked");
  });
});

// ------------------------------------------------------------------------------------
// 0.3.4: the creator-worker templates are refused until the repo is populated.
describe("12. creator-worker deploy guard", () => {
  test("creator-worker templates -> 409 until CREATOR_WORKER_READY; probe/repo-app unaffected; flag lifts it", async () => {
    const prior = process.env.CREATOR_WORKER_READY; // harness default is "1"
    const t = await newTenant("cw-guard");
    const prefix = (await req("GET", "/api/grants/verify", { token: t.token })).json.scope.workers.namePrefix;
    delete process.env.CREATOR_WORKER_READY; // the shipped default: guarded
    try {
      const r = await req("POST", "/api/deploys", { token: t.token, body: { name: prefix + "tip-1", template: "tip-alert-bot" } });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("creator_worker_repo_unpopulated");
      expect(r.json.detail.repo).toBe("RightOnPar-LLC/creator-worker");
      // builder also builds from creator-worker -> guarded
      expect((await req("POST", "/api/deploys", { token: t.token, body: { name: prefix + "b-1", template: "builder" } })).status).toBe(409);
      // probe is image-based, never touches the repo
      const p = await req("POST", "/api/deploys", { token: t.token, body: { name: prefix + "probe-1", template: "probe" } });
      expect(p.status).toBe(201);
      expect(p.json.status).toBe("dry_run");
      // repo-app pointed at a different populated org repo is unaffected by the guard
      const other = await req("POST", "/api/deploys", { token: t.token, body: { name: prefix + "app-1", template: "repo-app", repo: "RightOnPar-LLC/lsp-mcp" } });
      expect(other.status).toBe(201);
      // with the readiness flag the guard lifts (falls through to the normal dry run)
      process.env.CREATOR_WORKER_READY = "1";
      const ok = await req("POST", "/api/deploys", { token: t.token, body: { name: prefix + "tip-2", template: "tip-alert-bot" } });
      expect(ok.status).toBe(201);
      expect(ok.json.status).toBe("dry_run");
    } finally {
      if (prior === undefined) delete process.env.CREATOR_WORKER_READY;
      else process.env.CREATOR_WORKER_READY = prior;
    }
  });
});

describe("12. guest-welcome (Phase 1)", () => {
  test("POST /api/guest issues a working grant + welcome package in one keyless call", async () => {
    const r = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.1.1" }, body: { agent_name: "Wanderer" } });
    expect(r.status).toBe(201);
    expect(typeof r.json.grant).toBe("string");
    expect(r.json.budget.total).toBe(500);
    expect(r.json.budget.unit).toBe("usdCents");
    expect(r.json.budget.renews_in_sec).toBeGreaterThan(0);
    expect(r.json.budget.renews_in_sec).toBeLessThanOrEqual(3600);
    expect(r.json.directory.endsWith("/directory")).toBe(true);
    expect(r.json.house_rules.endsWith("/directory#rules")).toBe(true);
    expect(typeof r.json.graduation).toBe("string");
    // the grant verifies and carries exactly the guest envelope
    const v = await req("GET", "/api/grants/verify", { token: r.json.grant });
    expect(v.status).toBe(200);
    expect(v.json.caps).toEqual(["grant.read", "cog.plan", "memory.write", "deploy.worker", "ledger.read"]);
    expect(v.json.depth).toBe(1);
    expect(v.json.tenant).toBe("guest-pool");
    expect(v.json.sub.startsWith("guest:Wanderer:")).toBe(true);
    expect(v.json.budget.usd_cents).toBe(500);
    expect(v.json.constraints.maxWorkers).toBe(1);
    expect(v.json.constraints.requireDryRun).toBe(true);
    expect(v.json.scope.memory.partitions.length).toBe(1);
    expect(v.json.scope.memory.partitions[0].startsWith("guest/")).toBe(true);
  });

  test("a bodyless POST issues an anon guest; two guests get isolated memory partitions", async () => {
    const a = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.2.1" } });
    expect(a.status).toBe(201);
    const va = await req("GET", "/api/grants/verify", { token: a.json.grant });
    expect(va.json.sub.startsWith("guest:anon:")).toBe(true);
    const b = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.3.1" } });
    const vb = await req("GET", "/api/grants/verify", { token: b.json.grant });
    expect(va.json.scope.memory.partitions[0]).not.toBe(vb.json.scope.memory.partitions[0]);
  });

  test("a guest cannot issue grants or execute — those caps are absent, so it fails closed", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.4.1" } });
    const issue = await req("POST", "/api/grants", { token: g.json.grant, body: { sub: "child", caps: ["grant.read"] } });
    expect(issue.status).toBe(403);
    const exec = await req("POST", "/api/cog/execute", { token: g.json.grant, body: { proposal: {} } });
    expect(exec.status).toBe(403);
    const v = await req("GET", "/api/grants/verify", { token: g.json.grant });
    for (const forbidden of ["grant.issue", "code.write", "cog.execute", "store.clips.publish"]) {
      expect(v.json.caps.includes(forbidden)).toBe(false);
    }
  });

  test("guests share ONE depth-0 pool parent — verified via admin, not inferred (the economic breaker seam)", async () => {
    const a = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.5.1" } });
    const b = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.6.1" } });
    const va = await req("GET", "/api/grants/verify", { token: a.json.grant });
    const vb = await req("GET", "/api/grants/verify", { token: b.json.grant });
    // a guest is a leaf: grant.read shows it only its own subtree, which is just itself
    const own = await req("GET", "/api/grants", { token: a.json.grant });
    expect(own.json.grants.length).toBe(1);
    expect(own.json.grants[0].depth).toBe(1);
    // the shared parent is real and depth-0 — checked with admin so the "shared pool" claim can't pass under a two-pool bug
    const all = (await admin("GET", "/api/admin/grants")).json.grants;
    const ga = all.find((g) => g.id === va.json.id), gb = all.find((g) => g.id === vb.json.id);
    expect(ga.parent).toBeTruthy();
    expect(ga.parent).toBe(gb.parent); // both descend from the SAME pool root
    const parent = all.find((g) => g.id === ga.parent);
    expect(parent.depth).toBe(0);
    expect(parent.tenant).toBe("guest-pool");
  });

  test("a guest cannot do a LIVE deploy today — empty project scope refuses it (the real backstop, not requireDryRun)", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.7.1" } });
    // probe with no target: guest-pool has empty allowed_targets, so no project is in scope → never a live worker
    const probe = await req("POST", "/api/deploys", { token: g.json.grant, body: { name: "g-probe", template: "probe" } });
    if (probe.status === 201) expect(probe.json.executed).not.toBe(true);
    else expect(probe.status).toBeGreaterThanOrEqual(400);
    // a PAID template with confirm:true (which bypasses requireDryRun) is ALSO not executed — scope is the guard, not the flag
    const paid = await req("POST", "/api/deploys", { token: g.json.grant, body: { name: "g-paid", template: "tip-alert-bot", confirm: true } });
    if (paid.status === 201) expect(paid.json.executed).not.toBe(true);
    else expect(paid.status).toBeGreaterThanOrEqual(400);
  });

  test("GET /directory is public and lists priced capabilities with an honest reliability sample", async () => {
    const r = await req("GET", "/directory"); // no token
    expect(r.status).toBe(200);
    expect(r.json.service).toBe("creator-os-runtime");
    const probe = r.json.capabilities.find((c) => c.name === "probe");
    expect(probe).toBeTruthy();
    expect(probe.price.usd_cents).toBe(25);
    expect(probe.input_contract.requires).toEqual([]);
    expect(probe.guest_allowed).toBe(true);
    // reliability is never fabricated: a number always, and "no sample yet" when it has not run
    expect(typeof probe.reliability.runs).toBe("number");
    if (probe.reliability.runs === 0) expect(probe.reliability.note).toBe("no sample yet");
    // a paid template is listed but NOT guest-allowed
    const paid = r.json.capabilities.find((c) => c.name === "tip-alert-bot");
    expect(paid.guest_allowed).toBe(false);
    expect(paid.price.usd_cents).toBeGreaterThan(0);
    expect(Array.isArray(paid.input_contract.requires)).toBe(true);
  });

  test("the directory carries the house rules the welcome package points at (graduation, guest envelope)", async () => {
    const r = await req("GET", "/directory");
    expect(r.json.rules.graduation.settle_calls).toBe(10);
    expect(r.json.rules.guest_grant.caps).toEqual(["grant.read", "cog.plan", "memory.write", "deploy.worker", "ledger.read"]);
    expect(r.json.rules.guest_grant.worker_template).toBe("probe");
    expect(r.json.rules.guest_grant.budget_usd_cents).toBe(500);
    expect(r.json.guest.grant_via.endsWith("/api/guest")).toBe(true);
  });

  test("the welcome package's directory URL actually resolves — no dangling promise", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.8.1" } });
    const d = await req("GET", new URL(g.json.directory).pathname);
    expect(d.status).toBe(200);
    expect(Array.isArray(d.json.capabilities)).toBe(true);
    expect(g.json.house_rules).toBe(g.json.directory + "#rules");
  });
});

describe("12b. public base URL host hardening (keyless surfaces)", () => {
  test("PUBLIC_URL wins over a forged X-Forwarded-Host in the welcome package", async () => {
    const r = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.9.1",  "x-forwarded-host": "evil.com" } });
    expect(r.status).toBe(201);
    expect(r.json.directory.startsWith(BASE + "/")).toBe(true);
    expect(r.json.directory).not.toContain("evil.com");
    expect(r.json.house_rules).not.toContain("evil.com");
  });

  test("GET /directory ignores a forged Host", async () => {
    const r = await req("GET", "/directory", { headers: { "x-forwarded-host": "attacker.example" } });
    expect(r.json.guest.grant_via).toBe(BASE + "/api/guest");
    expect(JSON.stringify(r.json)).not.toContain("attacker.example");
  });

  test("fail-safe: PUBLIC_URL unset AND host untrusted -> 503, never emits the attacker host", async () => {
    const saved = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.10.1",  "x-forwarded-host": "evil.com" } });
      expect(g.status).toBe(503);
      expect(g.json.error).toBe("public_url_unset");
      expect(g.json.detail).toEqual({ needs: "PUBLIC_URL" });
      const d = await req("GET", "/directory", { headers: { "x-forwarded-host": "evil.com" } });
      expect(d.status).toBe(503);
      expect(d.text).not.toContain("evil.com");
    } finally {
      process.env.PUBLIC_URL = saved;
    }
  });

  test("dev is not broken: PUBLIC_URL unset with a loopback Host still works over http", async () => {
    const saved = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const r = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.11.1" } });
      expect(r.status).toBe(201);
      expect(r.json.directory).toContain("127.0.0.1");
      expect(r.json.directory.endsWith("/directory")).toBe(true);
    } finally {
      process.env.PUBLIC_URL = saved;
    }
  });

  test("shared surfaces inherit the fix — OAuth protected-resource metadata also fails safe, never advertising the attacker host", async () => {
    const saved = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const p = await req("GET", "/.well-known/oauth-protected-resource/mcp", { headers: { "x-forwarded-host": "evil.com" } });
      expect(p.status).toBe(503);
      expect(p.text).not.toContain("evil.com");
    } finally {
      process.env.PUBLIC_URL = saved;
    }
  });
});

describe("12c. probe-only deploy enforcement (scope.templates)", () => {
  test("a guest grant carries scope.templates=['probe'] (the allow-list is on the grant, not just advertised)", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.12.1" } });
    const v = await req("GET", "/api/grants/verify", { token: g.json.grant });
    expect(v.json.scope.templates).toEqual(["probe"]);
  });

  test("a guest is refused a paid template with a clean 403 — not charged, not planned — even with confirm:true", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.13.1" } });
    const paid = await req("POST", "/api/deploys", { token: g.json.grant, body: { name: "g-paid2", template: "tip-alert-bot", confirm: true } });
    expect(paid.status).toBe(403);
    expect(paid.json.error).toBe("template_not_allowed");
    expect(paid.json.detail.allowed).toContain("probe");
    expect(paid.json.detail.template).toBe("tip-alert-bot");
    // not charged
    expect((await req("GET", "/api/grants/verify", { token: g.json.grant })).json.remaining.usd_cents).toBe(500);
    // not planned (no deploys row written)
    expect((await dbQuery("SELECT count(*)::int AS n FROM deploys WHERE name = $1", ["g-paid2"])).rows[0].n).toBe(0);
  });

  test("a guest CAN still deploy the allowed probe (the allow-list does not over-block)", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.14.1" } });
    const probe = await req("POST", "/api/deploys", { token: g.json.grant, body: { name: "g-probe3", template: "probe" } });
    expect(probe.json.error).not.toBe("template_not_allowed");
    if (probe.status === 201) expect(probe.json.executed).not.toBe(true); // still gated by empty project scope
  });

  test("negative control: a restricted templates list cannot be widened, and a child inherits it when it omits one", async () => {
    const root = await newTenant("tmpl-neg", "pro");
    const A = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:a", caps: ["deploy.worker", "grant.issue"], scope: { templates: ["probe"] }, ttlSec: 600, budget: { usd_cents: 100, calls: 5, deploys: 2 } } });
    expect(A.status).toBe(201);
    expect((await req("GET", "/api/grants/verify", { token: A.json.token })).json.scope.templates).toEqual(["probe"]);
    // widen attempt from A -> rejected (THE paired control: goes RED if the subset check is removed/inverted)
    const bad = await req("POST", "/api/grants", { token: A.json.token, body: { sub: "agent:b", caps: ["deploy.worker"], scope: { templates: ["tip-alert-bot"] }, ttlSec: 300, budget: { usd_cents: 50, calls: 2, deploys: 1 } } });
    expect(bad.status).toBe(403);
    expect(bad.json.error).toBe("attenuation_violation");
    expect(bad.json.detail).toContain("scope_templates_widened");
    // omitting the scope inherits A's list (fail-closed) — it does NOT silently become wildcard
    const C = await req("POST", "/api/grants", { token: A.json.token, body: { sub: "agent:c", caps: ["deploy.worker"], ttlSec: 300, budget: { usd_cents: 50, calls: 2, deploys: 1 } } });
    expect(C.status).toBe(201);
    expect((await req("GET", "/api/grants/verify", { token: C.json.token })).json.scope.templates).toEqual(["probe"]);
  });

  test("backward-compat: a wildcard grant (no scope.templates) is unrestricted — existing tenants keep full template access", async () => {
    const t = await newTenant("tmpl-compat", "pro");
    const dep = await req("POST", "/api/deploys", { token: t.token, body: { name: "compat-tip-1", template: "tip-alert-bot" } });
    expect(dep.json.error).not.toBe("template_not_allowed"); // a non-probe template is fine for a wildcard grant
  });
});

describe("13. guest sybil defence (per-fingerprint, keyed on X-Real-IP)", () => {
  const fpOf = async (token) => {
    const id = (await req("GET", "/api/grants/verify", { token })).json.id;
    return (await dbQuery("SELECT fp FROM guest_fingerprints WHERE grant_id = $1", [id])).rows[0].fp;
  };

  test("one active grant per fingerprint: a second mint from the SAME X-Real-IP is refused; a different IP is independent", async () => {
    const ip = "10.13.1.1";
    const first = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    expect(first.status).toBe(201);
    const second = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("guest_grant_active");
    const other = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.13.1.2" } });
    expect(other.status).toBe(201); // per-fingerprint isolation
  });

  test("rate limit: GUEST_MAX_PER_HOUR (3) mints per window per fingerprint, then 429", async () => {
    const ip = "10.13.2.1";
    const m1 = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    expect(m1.status).toBe(201);
    const fp = await fpOf(m1.json.grant);
    // clear the active-lock between mints so the RATE cap (not one-active) is what governs
    await dbQuery("UPDATE guest_fingerprints SET grant_exp = 0 WHERE fp = $1", [fp]);
    expect((await req("POST", "/api/guest", { headers: { "x-real-ip": ip } })).status).toBe(201); // count 2
    await dbQuery("UPDATE guest_fingerprints SET grant_exp = 0 WHERE fp = $1", [fp]);
    expect((await req("POST", "/api/guest", { headers: { "x-real-ip": ip } })).status).toBe(201); // count 3
    await dbQuery("UPDATE guest_fingerprints SET grant_exp = 0 WHERE fp = $1", [fp]);
    const m4 = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    expect(m4.status).toBe(429);
    expect(m4.json.error).toBe("guest_rate_limited");
  });

  test("privacy: no raw IP is ever stored — only the salted HMAC fingerprint", async () => {
    const ip = "203.0.113.77";
    await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    const rows = (await dbQuery("SELECT * FROM guest_fingerprints")).rows;
    expect(JSON.stringify(rows)).not.toContain(ip); // the raw IP appears nowhere
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.fp))).toBe(true); // every fp is a 64-hex hash
  });

  test("the salt salts AND rotates: the same IP yields a different fingerprint after rotation (old fingerprints unlinkable)", async () => {
    const ip = "10.13.4.1";
    const a = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    expect(a.status).toBe(201);
    const fp1 = await fpOf(a.json.grant);
    await dbQuery("UPDATE settings SET updated_at = now() - interval '30 days' WHERE key = 'guest_fp_salt'"); // force rotation
    const b = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } }); // rotated salt -> new fp -> not one-active-blocked
    expect(b.status).toBe(201);
    const fp2 = await fpOf(b.json.grant);
    expect(fp2).not.toBe(fp1);
  });

  test("Law 5 — the directory advertises exactly what is enforced", async () => {
    const r = await req("GET", "/directory", { headers: { "x-real-ip": "10.13.5.1" } });
    expect(r.json.rules.issuance.per_fingerprint_per_hour).toBe(3); // GUEST_MAX_PER_HOUR default
    expect(r.json.rules.issuance.one_active_grant_per_fingerprint).toBe(true);
  });
});

describe("14. guest own-ledger (subtree-scoped)", () => {
  test("a guest reads ONLY its own ledger — never a sibling guest's or the pool root's", async () => {
    const a = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.14.1.1" } });
    const b = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.14.1.2" } });
    const va = await req("GET", "/api/grants/verify", { token: a.json.grant });
    const vb = await req("GET", "/api/grants/verify", { token: b.json.grant });
    const led = await req("GET", "/api/ledger", { token: a.json.grant });
    expect(led.status).toBe(200);
    expect(led.json.ledger.length).toBeGreaterThanOrEqual(1); // its own 'reserve' row
    expect(led.json.ledger.every((l) => l.grant_id === va.json.id)).toBe(true);
    expect(led.json.ledger.some((l) => l.grant_id === vb.json.id)).toBe(false); // never a sibling's
    expect(led.json.ledger.some((l) => l.kind === "root")).toBe(false); // never the pool root's
  });

  test("the isolation holds over the MCP ledger_query tool too", async () => {
    const a = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.14.2.1" } });
    const b = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.14.2.2" } });
    const va = await req("GET", "/api/grants/verify", { token: a.json.grant });
    const vb = await req("GET", "/api/grants/verify", { token: b.json.grant });
    const r = await mcp(a.json.grant, "tools/call", { name: "ledger_query", arguments: { limit: 200 } });
    const rows = r.json.result.structuredContent.ledger;
    expect(rows.every((l) => l.grant_id === va.json.id)).toBe(true);
    expect(rows.some((l) => l.grant_id === vb.json.id)).toBe(false);
  });

  test("normal tenant preserved: the root sees its whole subtree; a delegated child sees only its own rows", async () => {
    const root = await newTenant("led-sub", "pro");
    const child = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:led", caps: ["ledger.read", "deploy.worker"], ttlSec: 600, budget: { usd_cents: 50, calls: 3, deploys: 1 } } });
    expect(child.status).toBe(201);
    const vc = await req("GET", "/api/grants/verify", { token: child.json.token });
    const rootLed = await req("GET", "/api/ledger", { token: root.token });
    expect(rootLed.json.ledger.some((l) => l.grant_id === vc.json.id)).toBe(true); // subtree includes the child
    expect(rootLed.json.ledger.some((l) => l.kind === "root")).toBe(true); // and its own root row
    const childLed = await req("GET", "/api/ledger", { token: child.json.token });
    expect(childLed.json.ledger.every((l) => l.grant_id === vc.json.id)).toBe(true); // only its own
    expect(childLed.json.ledger.some((l) => l.kind === "root")).toBe(false); // not the root's
  });
});

describe("15. guest memory-write cap + brain-sync quarantine", () => {
  const freshGuest = async (ip) => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    const v = await req("GET", "/api/grants/verify", { token: g.json.grant });
    return { token: g.json.grant, base: v.json.scope.memory.partitions[0] };
  };

  test("guest writes are rate-capped tighter than the generic limit (10/min, own meter)", async () => {
    const { token, base } = await freshGuest("10.15.1.1");
    for (let i = 0; i < 10; i++) {
      const w = await req("POST", "/api/memory", { token, body: { partition: base, key: "k" + i, content: "x" } });
      expect(w.status).toBe(201);
    }
    const over = await req("POST", "/api/memory", { token, body: { partition: base, key: "k10", content: "x" } });
    expect(over.status).toBe(429);
    expect(over.json.error).toBe("memory_write_rate_limited"); // dedicated meter, not the generic 'rate_limited'
  });

  test("per-guest row cap, with updates to an existing key exempt", async () => {
    const { token, base } = await freshGuest("10.15.2.1");
    await dbQuery(
      "INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at) SELECT 'seed_'||g, 'guest-pool', $1, 'seedkey_'||g, 'x', '[]'::jsonb, 1, false, 'seed', now() FROM generate_series(1,100) g",
      [base],
    );
    const over = await req("POST", "/api/memory", { token, body: { partition: base, key: "newk", content: "x" } });
    expect(over.status).toBe(429);
    expect(over.json.error).toBe("memory_partition_full");
    const upd = await req("POST", "/api/memory", { token, body: { partition: base, key: "seedkey_1", content: "updated" } });
    expect(upd.status).toBe(201); // updating an existing key does not grow storage -> exempt
  });

  test("per-guest byte cap on a new row", async () => {
    const { token, base } = await freshGuest("10.15.3.1");
    await dbQuery(
      "INSERT INTO memories (id, tenant, partition, key, content, tags, version, deleted, actor, updated_at) VALUES ('bigseed', 'guest-pool', $1, 'big', $2, '[]'::jsonb, 1, false, 'seed', now())",
      [base, "z".repeat(262044)],
    );
    const over = await req("POST", "/api/memory", { token, body: { partition: base, key: "morebytes", content: "y".repeat(200) } });
    expect(over.status).toBe(413);
    expect(over.json.error).toBe("memory_partition_bytes");
  });

  test("QUARANTINE: a guest write enqueues NO brain sync; a normal tenant write does", async () => {
    const savedUrl = process.env.COG_BRIDGE_URL, savedTok = process.env.COG_BRIDGE_TOKEN;
    process.env.COG_BRIDGE_URL = "http://127.0.0.1:1"; // arm the bridge so enqueueOutbox writes a row (drain fails silently)
    process.env.COG_BRIDGE_TOKEN = "x";
    try {
      const cnt = async () => (await dbQuery("SELECT count(*)::int AS n FROM outbox WHERE kind = 'memory.sync'")).rows[0].n;
      const before = await cnt();
      const { token, base } = await freshGuest("10.15.4.1");
      await req("POST", "/api/memory", { token, body: { partition: base, key: "q", content: "guest" } });
      expect(await cnt()).toBe(before); // guest write is quarantined — nothing enqueued
      const t = await newTenant("mem-sync", "pro");
      await req("POST", "/api/memory", { token: t.token, body: { partition: "tenant", key: "n", content: "normal" } });
      expect(await cnt()).toBe(before + 1); // a normal tenant write DOES sync
    } finally {
      if (savedUrl === undefined) delete process.env.COG_BRIDGE_URL; else process.env.COG_BRIDGE_URL = savedUrl;
      if (savedTok === undefined) delete process.env.COG_BRIDGE_TOKEN; else process.env.COG_BRIDGE_TOKEN = savedTok;
    }
  });

  test("normal tenants are unaffected — many writes, no guest caps trip", async () => {
    const t = await newTenant("mem-normal", "pro");
    for (let i = 0; i < 12; i++) {
      const w = await req("POST", "/api/memory", { token: t.token, body: { partition: "tenant", key: "n" + i, content: "x" } });
      expect(w.status).toBe(201); // 12 > the guest 10/min cap but under the generic limit; normal tenants aren't guest-capped
    }
  });

  test("Law 5 — the directory advertises the enforced memory limits", async () => {
    const r = await req("GET", "/directory", { headers: { "x-real-ip": "10.15.9.1" } });
    expect(r.json.rules.memory.writes_per_min).toBe(10);
    expect(r.json.rules.memory.max_memories).toBe(100);
    expect(r.json.rules.memory.max_bytes).toBe(262144);
    expect(r.json.rules.memory.brain_sync).toBe("quarantined");
  });
});

describe("16. guest pool circuit breaker", () => {
  test("a drained pool refuses with a clean 503, and auto-resumes when it refills — no restart", async () => {
    // materialize the pool, then find its depth-0 root
    const g0 = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.16.1.1" } });
    expect(g0.status).toBe(201);
    const pool = (await admin("GET", "/api/admin/grants")).json.grants.find((x) => x.tenant === "guest-pool" && x.depth === 0);
    expect(pool).toBeTruthy();
    const budget = typeof pool.budget === "string" ? JSON.parse(pool.budget) : pool.budget;
    const origReserved = typeof pool.reserved === "string" ? pool.reserved : JSON.stringify(pool.reserved);
    try {
      // drain: reserve the whole pool budget so remaining slots hit 0
      await dbQuery("UPDATE grants SET reserved = $1::jsonb WHERE id = $2", [JSON.stringify(budget), pool.id]);
      const dry = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.16.1.2" } });
      expect(dry.status).toBe(503);
      expect(dry.json.error).toBe("guest_pool_exhausted");
      expect(dry.json.detail.remaining_slots).toBe(0);
      expect(dry.json.detail.retry_after_sec).toBeGreaterThan(0);
      expect((await admin("GET", "/api/admin/overview")).json.guest_pool.open).toBe(false);
      // refill (simulate the reaper releasing reservations) -> next call passes, no restart/flag
      await dbQuery("UPDATE grants SET reserved = $1::jsonb WHERE id = $2", [origReserved, pool.id]);
      const back = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.16.1.3" } });
      expect(back.status).toBe(201);
      expect((await admin("GET", "/api/admin/overview")).json.guest_pool.open).toBe(true);
    } finally {
      await dbQuery("UPDATE grants SET reserved = $1::jsonb WHERE id = $2", [origReserved, pool.id]);
    }
  });

  test("the envelope is single-sourced: a fresh guest's budget equals TIERS.guest (breaker slot math and the grant can't drift)", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.16.2.1" } });
    expect(g.json.budget.total).toBe(500); // == TIERS.guest.usdCents, from GUEST_BUDGET()
    const v = await req("GET", "/api/grants/verify", { token: g.json.grant });
    expect(v.json.budget.usd_cents).toBe(500);
  });
});

describe("17. keyless guest_welcome over MCP", () => {
  // req directly (not the mcp() helper) so we can set x-real-ip for the sybil gate
  const mcpGuest = (ip, args = {}) =>
    req("POST", "/mcp", { headers: { "x-real-ip": ip }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_welcome", arguments: args } } });

  test("keyless mint: guest_welcome over /mcp with NO token yields the same working guest grant as POST /api/guest", async () => {
    const r = await mcpGuest("10.17.1.1", { agent_name: "McpWanderer" });
    expect(r.status).toBe(200);
    const pkg = r.json.result.structuredContent;
    expect(typeof pkg.grant).toBe("string");
    expect(pkg.budget.total).toBe(500);
    expect(pkg.directory.endsWith("/directory")).toBe(true);
    const v = await req("GET", "/api/grants/verify", { token: pkg.grant });
    expect(v.json.caps).toEqual(["grant.read", "cog.plan", "memory.write", "deploy.worker", "ledger.read"]);
    expect(v.json.tenant).toBe("guest-pool");
    expect(v.json.sub.startsWith("guest:McpWanderer:")).toBe(true);
    expect(v.json.depth).toBe(1);
  });

  test("no OTHER door opens: every other keyless /mcp method is still 401 missing_grant", async () => {
    for (const m of ["initialize", "tools/list", "ping"]) {
      const r = await mcp(undefined, m, {});
      expect(r.status).toBe(401);
      expect(r.json.error).toBe("missing_grant");
    }
    // a DIFFERENT tools/call name keyless is refused — only guest_welcome passes
    const other = await mcp(undefined, "tools/call", { name: "memory_write", arguments: { content: "x" } });
    expect(other.status).toBe(401);
    expect(other.json.error).toBe("missing_grant");
  });

  test("attenuation parity: the MCP-minted guest is the same fail-closed envelope", async () => {
    const r = await mcpGuest("10.17.3.1");
    const tok = r.json.result.structuredContent.grant;
    expect((await req("POST", "/api/grants", { token: tok, body: { sub: "child", caps: ["grant.read"] } })).status).toBe(403);
    expect((await req("POST", "/api/cog/execute", { token: tok, body: { proposal: {} } })).status).toBe(403);
  });

  test("the kill switch closes the keyless door too", async () => {
    try {
      await admin("POST", "/api/admin/kill");
      const paused = await mcpGuest("10.17.4.1");
      expect(paused.status).toBe(503);
      expect(paused.json.error).toBe("runtime_paused");
    } finally {
      await admin("POST", "/api/admin/resume");
    }
    const back = await mcpGuest("10.17.4.2");
    expect(back.status).toBe(200);
  });

  test("discoverability: the public keyless GET /mcp lists guest_welcome", async () => {
    const r = await req("GET", "/mcp");
    expect(r.json.tools).toContain("guest_welcome");
  });
});

describe("18. step-4 double-loop fixes (regression controls)", () => {
  test("HIGH: a failed mint releases the fingerprint lock — no self-inflicted 409 lockout", async () => {
    const ip = "10.18.1.1";
    const g1 = await req("POST", "/api/guest", { headers: { "x-real-ip": ip } });
    expect(g1.status).toBe(201);
    // expire this fp's active-lock so a re-mint passes the one-active gate
    const gid = (await req("GET", "/api/grants/verify", { token: g1.json.grant })).json.id;
    const fp = (await dbQuery("SELECT fp FROM guest_fingerprints WHERE grant_id = $1", [gid])).rows[0].fp;
    await dbQuery("UPDATE guest_fingerprints SET grant_exp = 0 WHERE fp = $1", [fp]);
    // drain the pool so the NEXT mint fails AFTER the fingerprint claim (breaker 503)
    const pool = (await admin("GET", "/api/admin/grants")).json.grants.find((x) => x.tenant === "guest-pool" && x.depth === 0);
    const budget = typeof pool.budget === "string" ? JSON.parse(pool.budget) : pool.budget;
    const orig = typeof pool.reserved === "string" ? pool.reserved : JSON.stringify(pool.reserved);
    try {
      await dbQuery("UPDATE grants SET reserved = $1::jsonb WHERE id = $2", [JSON.stringify(budget), pool.id]);
      expect((await req("POST", "/api/guest", { headers: { "x-real-ip": ip } })).status).toBe(503); // mint failed after claim
    } finally {
      await dbQuery("UPDATE grants SET reserved = $1::jsonb WHERE id = $2", [orig, pool.id]);
    }
    // the fingerprint must NOT be locked: the same IP mints again immediately (was 409 before the fix)
    expect((await req("POST", "/api/guest", { headers: { "x-real-ip": ip } })).status).toBe(201);
  });

  test("HIGH: a guest's forget is quarantined from the brain sync (write-then-forget cannot leak)", async () => {
    const savedUrl = process.env.COG_BRIDGE_URL, savedTok = process.env.COG_BRIDGE_TOKEN;
    process.env.COG_BRIDGE_URL = "http://127.0.0.1:1";
    process.env.COG_BRIDGE_TOKEN = "x";
    try {
      const cnt = async () => (await dbQuery("SELECT count(*)::int AS n FROM outbox WHERE kind = 'memory.sync'")).rows[0].n;
      const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.18.2.1" } });
      const base = (await req("GET", "/api/grants/verify", { token: g.json.grant })).json.scope.memory.partitions[0];
      const w = await req("POST", "/api/memory", { token: g.json.grant, body: { partition: base, key: "q", content: "guest secret" } });
      expect(w.status).toBe(201);
      const before = await cnt();
      const f = await req("DELETE", "/api/memory/" + w.json.memory.id, { token: g.json.grant });
      expect(f.status).toBe(200);
      expect(await cnt()).toBe(before); // guest forget enqueued NO sync (was +1 before the fix)
      // a normal tenant's forget DOES sync
      const t = await newTenant("forget-sync", "pro");
      const nw = await req("POST", "/api/memory", { token: t.token, body: { partition: "tenant", key: "n", content: "x" } });
      const b2 = await cnt();
      await req("DELETE", "/api/memory/" + nw.json.memory.id, { token: t.token });
      expect(await cnt()).toBe(b2 + 1);
    } finally {
      if (savedUrl === undefined) delete process.env.COG_BRIDGE_URL; else process.env.COG_BRIDGE_URL = savedUrl;
      if (savedTok === undefined) delete process.env.COG_BRIDGE_TOKEN; else process.env.COG_BRIDGE_TOKEN = savedTok;
    }
  });

  test("MED: the guest byte cap applies to UPDATES too (was bypassable via existing keys)", async () => {
    const g = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.18.3.1" } });
    const base = (await req("GET", "/api/grants/verify", { token: g.json.grant })).json.scope.memory.partitions[0];
    await dbQuery(
      "INSERT INTO memories (id,tenant,partition,key,content,tags,version,deleted,actor,updated_at) VALUES ('ka','guest-pool',$1,'ka',$2,'[]'::jsonb,1,false,'seed',now()),('kb','guest-pool',$1,'kb',$3,'[]'::jsonb,1,false,'seed',now())",
      [base, "z".repeat(250000), "z".repeat(1000)],
    );
    // updating the EXISTING key kb to 20000 bytes pushes the partition total over the cap
    const over = await req("POST", "/api/memory", { token: g.json.grant, body: { partition: base, key: "kb", content: "y".repeat(20000) } });
    expect(over.status).toBe(413);
    expect(over.json.error).toBe("memory_partition_bytes");
  });
});

describe("reservation reaper (runtime-wide)", () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const remainingOf = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining;

  test("drain -> reap -> recover: an expired child's unspent reservation returns to its parent, idempotently", async () => {
    const root = await newTenant("reaper-a", "pro");
    // intermediate parent P: small calls budget + the right to issue children
    const P = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:P", caps: ["grant.issue", "deploy.worker"], ttlSec: 3600, budget: { usd_cents: 100, calls: 4, deploys: 2 } } });
    expect(P.status).toBe(201);
    const c1 = await req("POST", "/api/grants", { token: P.json.token, body: { sub: "agent:c1", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 10, calls: 2, deploys: 1 } } });
    const c2 = await req("POST", "/api/grants", { token: P.json.token, body: { sub: "agent:c2", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 10, calls: 2, deploys: 1 } } });
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    // CONTROL: P is drained (this assertion FAILS if the reaper is a no-op later)
    expect((await remainingOf(P.json.token)).calls).toBe(0);
    const denied = await req("POST", "/api/grants", { token: P.json.token, body: { sub: "agent:c3", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 10, calls: 1, deploys: 1 } } });
    expect(denied.status).toBeGreaterThanOrEqual(400); // budget_exceeds_parent_remaining
    // expire both children, sweep
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = ANY($2)", [past, [c1.json.id, c2.json.id]]);
    const reaped = (await admin("POST", "/api/admin/grants/reap")).json.reaped;
    expect(reaped).toContain(c1.json.id);
    expect(reaped).toContain(c2.json.id);
    // recovered: P's calls back to the full 4
    expect((await remainingOf(P.json.token)).calls).toBe(4);
    // idempotency: a second sweep releases nothing and does NOT over-credit (still 4, not 8)
    const again = (await admin("POST", "/api/admin/grants/reap")).json.reaped;
    expect(again).not.toContain(c1.json.id);
    expect((await remainingOf(P.json.token)).calls).toBe(4);
    // and issuance works again
    const c4 = await req("POST", "/api/grants", { token: P.json.token, body: { sub: "agent:c4", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 10, calls: 1, deploys: 1 } } });
    expect(c4.status).toBe(201);
  });

  test("no double-release across paths: revoking an already-reaped grant does not credit its parent a second time", async () => {
    const root = await newTenant("reaper-b", "pro");
    const P = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:P2", caps: ["grant.issue", "deploy.worker"], ttlSec: 3600, budget: { usd_cents: 100, calls: 3, deploys: 2 } } });
    const c = await req("POST", "/api/grants", { token: P.json.token, body: { sub: "agent:cR", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 10, calls: 2, deploys: 1 } } });
    expect(c.status).toBe(201);
    expect((await remainingOf(P.json.token)).calls).toBe(1); // 3 - 2 reserved
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, c.json.id]);
    expect((await admin("POST", "/api/admin/grants/reap")).json.reaped).toContain(c.json.id);
    expect((await remainingOf(P.json.token)).calls).toBe(3); // released once by the sweep
    // now revoke the already-expired grant: it must be skipped, NOT release again
    const rev = await req("POST", "/api/grants/" + c.json.id + "/revoke", { token: P.json.token, body: { reason: "post-reap" } });
    expect(rev.status).toBe(200);
    expect(rev.json.revoked).not.toContain(c.json.id); // already expired -> revoke skips it
    expect((await remainingOf(P.json.token)).calls).toBe(3); // still 3, never 5
  });

  test("a root grant reaped safely: it flips to expired, releases nothing upward, and the sweep does not throw", async () => {
    const root = await newTenant("reaper-root", "starter");
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, root.grantId]);
    const reaped = (await admin("POST", "/api/admin/grants/reap")).json.reaped;
    expect(Array.isArray(reaped)).toBe(true);
    expect(reaped).toContain(root.grantId);
    const grants = (await admin("GET", "/api/admin/grants")).json.grants;
    expect(grants.find((g) => g.id === root.grantId).status).toBe("expired");
  });

  // Guards the deadlock fix's refactor: the sweep is now one txn PER GRANT over an
  // unlocked, depth-DESC candidate scan (not one batch txn). This proves a full
  // multi-level chain is still reaped in a single sweep and each parent is credited
  // its child's unspent reservation at every level. (The deadlock itself is a
  // lock-ordering invariant — single-grant child→parent txns cannot cycle in a tree —
  // not a behavior this single-connection PGlite harness can exercise; see the PR.)
  test("multi-level: a 3-deep expired chain is fully reaped in one sweep, crediting every parent", async () => {
    const root = await newTenant("reaper-deep", "pro");
    const P = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:dP", caps: ["grant.issue", "deploy.worker"], ttlSec: 3600, budget: { usd_cents: 100, calls: 6, deploys: 3 } } });
    const C = await req("POST", "/api/grants", { token: P.json.token, body: { sub: "agent:dC", caps: ["grant.issue", "deploy.worker"], ttlSec: 3600, budget: { usd_cents: 50, calls: 4, deploys: 2 } } });
    const GC = await req("POST", "/api/grants", { token: C.json.token, body: { sub: "agent:dGC", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 20, calls: 2, deploys: 1 } } });
    expect(GC.status).toBe(201);
    // reservations flowed up: C holds 2 of its 4 for GC; P holds 4 of its 6 for C
    expect((await remainingOf(C.json.token)).calls).toBe(2);
    expect((await remainingOf(P.json.token)).calls).toBe(2);
    // expire the entire chain and sweep ONCE
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = ANY($2)", [past, [GC.json.id, C.json.id, P.json.id]]);
    const reaped = (await admin("POST", "/api/admin/grants/reap")).json.reaped;
    expect(reaped).toContain(GC.json.id);
    expect(reaped).toContain(C.json.id);
    expect(reaped).toContain(P.json.id);
    // every level flipped and root got P's full unspent back (P used nothing → 6 calls returned)
    const grants = (await admin("GET", "/api/admin/grants")).json.grants;
    for (const id of [GC.json.id, C.json.id, P.json.id]) expect(grants.find((g) => g.id === id).status).toBe("expired");
    const rootRow = grants.find((g) => g.id === root.grantId);
    const reserved = typeof rootRow.reserved === "string" ? JSON.parse(rootRow.reserved) : rootRow.reserved || {};
    expect(reserved.calls || 0).toBe(0); // P's reservation (6 calls) fully returned to root — chain released top-to-bottom
  });
});
