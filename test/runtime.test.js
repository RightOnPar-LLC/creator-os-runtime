// Characterisation suite for creator-os-runtime. Written against the UNSPLIT
// src/runtime.js (the proven-readable form of the live 0.3.0 bundle) so that any
// refactor has to keep every behaviour pinned here.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
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
      railwayWebhook: true, github: true, brain: true, mesh: true, ollama: false,
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
      ["probe", "tip-alert-bot", "paywall-link", "clip-poster", "dm-autoresponder", "webhook-relay", "repo-app", "builder", "agent-host"],
    );
    expect(mod.CAPS.length).toBe(26);
    expect(mod.CAPS.slice(20)).toEqual(["code.write", "lsp.diagnose", "lsp.hover", "lsp.definition", "lsp.references", "escrow.hold"]);
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

  // Listing must never reach further than assertMemoryScope allows. It used to be a bare
  // `LIKE prefix%`, so a key for "article:job4" could LIST "article:job42" although it
  // could not read or write it by name.
  test("listing memory keeps the same boundary: a key for one section never lists a longer-named one", async () => {
    const t = await newTenant("list-boundary");
    for (const [partition, content] of [
      ["agent:report:", "report brief"], ["agent:report:notes", "report notes"], ["agent:report2:", "report2 brief"],
      ["worker:a", "a"], ["worker:ab", "ab"], ["worker:a-shard1", "a shard"], ["a_c", "underscore"], ["abc", "letters"],
    ]) expect((await req("POST", "/api/memory", { token: t.token, body: { partition, content } })).status).toBe(201);
    const key = async (partitions) =>
      (await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:reader", caps: ["memory.read"], ttlSec: 600, scope: { memory: { partitions } } } })).json.token;
    const list = async (token, q = "") =>
      ((await req("GET", "/api/memory?limit=50" + (q ? "&q=" + q : ""), { token })).json.memories || []).map((m) => m.partition).sort();
    expect(await list(await key(["agent:report:"]))).toEqual(["agent:report:", "agent:report:notes"]);
    expect(await list(await key(["worker:a"]))).toEqual(["worker:a", "worker:a-shard1"]);
    // % and _ in a scope are ordinary characters, not wildcards.
    expect(await list(await key(["a_c"]))).toEqual(["a_c"]);
    // The same boundary holds when searching by words.
    expect(await list(await key(["agent:report:"]), "brief")).toEqual(["agent:report:"]);
    // The root key (no memory scope = everything) still lists everything.
    expect((await list(t.token)).length).toBe(8);
  });

  test("a key with an empty memory scope lists nothing and reads nothing", async () => {
    const t = await newTenant("empty-scope");
    expect((await req("POST", "/api/memory", { token: t.token, body: { partition: "tenant", content: "the past" } })).status).toBe(201);
    // The old code searched for `partition LIKE 'undefined%'`: it returned nothing only by
    // accident, and it DID return this one.
    expect((await req("POST", "/api/memory", { token: t.token, body: { partition: "undefined-leftovers", content: "must never be listed" } })).status).toBe(201);
    const blank = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:new", caps: ["memory.read"], ttlSec: 600, scope: { memory: { partitions: [] } } } });
    expect(blank.status).toBe(201);
    const listed = await req("GET", "/api/memory?limit=50", { token: blank.json.token });
    expect(listed.status).toBe(200);
    expect(listed.json.memories).toEqual([]);
    const asked = await req("GET", "/api/memory?partition=tenant", { token: blank.json.token });
    expect(asked.status).toBe(403);
    expect(asked.json.error).toBe("out_of_scope");
  });

  // The owner's rule: a key an AGENT hands to a sub-agent lives 24 hours at most. The
  // owner's own (root) key keeps the tier's limit.
  test("a key handed out by an agent lives 24 hours at most; the owner's own key keeps the tier's limit", async () => {
    const t = await newTenant("ttl-owner", "studio"); // studio allows 7 days
    const week = 7 * 86400;
    const now = Math.floor(Date.now() / 1000);
    const lead = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:lead", caps: ["grant.issue", "grant.read"], ttlSec: week } });
    expect(lead.status).toBe(201);
    expect(lead.json.exp).toBeGreaterThan(now + 6 * 86400); // owner-issued: unchanged
    const helper = await req("POST", "/api/grants", { token: lead.json.token, body: { sub: "agent:helper", caps: ["grant.read"], ttlSec: week } });
    expect(helper.status).toBe(201);
    expect(helper.json.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86400);
    expect(helper.json.exp).toBeGreaterThan(now + 86400 - 120); // capped at a day, not cut further
    // Asking for less than a day is still honoured.
    const brief = await req("POST", "/api/grants", { token: lead.json.token, body: { sub: "agent:brief", caps: ["grant.read"], ttlSec: 600 } });
    expect(brief.json.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
  });

  test("the 24-hour rule reaches every level and a host's hires, but not a payment hold", async () => {
    const t = await newTenant("ttl-levels", "studio");
    const week = 7 * 86400;
    const day = 86400;
    const now = () => Math.floor(Date.now() / 1000);
    const lead = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:lead", caps: ["grant.issue", "grant.read", "escrow.hold"], ttlSec: week, budget: { usd_cents: 1000, calls: 10, deploys: 0 } },
    });
    expect(lead.status).toBe(201);
    const second = await req("POST", "/api/grants", { token: lead.json.token, body: { sub: "agent:second", caps: ["grant.issue", "grant.read"], ttlSec: week } });
    expect(second.status).toBe(201);
    expect(second.json.exp).toBeLessThanOrEqual(now() + day);
    const third = await req("POST", "/api/grants", { token: second.json.token, body: { sub: "agent:third", caps: ["grant.read"], ttlSec: week } });
    expect(third.status).toBe(201);
    expect(third.json.exp).toBeLessThanOrEqual(now() + day);
    // A host is made by the owner (root), so it keeps the tier's limit. What it HIRES is an
    // agent's sub-agent.
    const host = await req("POST", "/api/hosts", { token: t.token, body: { name: "desk" } });
    expect(host.status).toBe(201);
    const hire = await req("POST", "/api/grants", {
      token: host.json.token,
      body: { sub: "agent:worker", caps: ["grant.read"], ttlSec: week, budget: { usd_cents: 10, calls: 5, deploys: 0 } },
    });
    expect(hire.status).toBe(201);
    expect(hire.json.exp).toBeLessThanOrEqual(now() + day);
    // A payment hold opened by an agent keeps the deadline the payer chose. Cutting it to a
    // day would refund the payer early and leave a later, valid delivery unpaid.
    const hold = await req("POST", "/api/escrow", {
      token: lead.json.token,
      body: { amount: 500, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, deadline: now() + 3 * day },
    });
    expect(hold.status).toBe(201);
    expect(hold.json.escrow.deadline).toBeGreaterThan(now() + 2 * day);
  });

  // A hold cannot outlive the key that pays for it, and a key an agent was handed lives a day.
  // So an agent's sub-agent asking for a 3-day hold must be TOLD no, never given a 1-day hold
  // that looks like a 3-day one.
  test("a payment hold asked to outlast the payer's own key is refused, never quietly shortened", async () => {
    const t = await newTenant("hold-outlives-payer", "studio");
    const week = 7 * 86400;
    const day = 86400;
    const now = () => Math.floor(Date.now() / 1000);
    const lead = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:lead", caps: ["grant.issue", "grant.read", "escrow.hold"], ttlSec: week, budget: { usd_cents: 1000, calls: 10, deploys: 0 } },
    });
    const second = await req("POST", "/api/grants", {
      token: lead.json.token,
      body: { sub: "agent:second", caps: ["grant.read", "escrow.hold"], ttlSec: week, budget: { usd_cents: 600, calls: 5, deploys: 0 } },
    });
    expect(second.status).toBe(201);
    expect(second.json.exp).toBeLessThanOrEqual(now() + day);
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    for (const over of [{ deadline: now() + 3 * day }, { ttlSec: 3 * day }]) {
      const r = await req("POST", "/api/escrow", { token: second.json.token, body: body(over) });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("escrow_deadline_exceeds_payer_key");
      expect(r.json.detail.payer_exp).toBe(second.json.exp);
    }
    // nothing was held by the refusals: the whole budget is still there for a hold that fits
    const fits = await req("POST", "/api/escrow", { token: second.json.token, body: body({ amount: 600, deadline: second.json.exp }) });
    expect(fits.status).toBe(201);
    expect(fits.json.escrow.deadline).toBe(second.json.exp);
    // with no deadline asked, the default (an hour) still opens
    const lead2 = await req("POST", "/api/escrow", { token: lead.json.token, body: body({}) });
    expect(lead2.status).toBe(201);
    expect(lead2.json.escrow.deadline).toBeLessThanOrEqual(now() + 3600);
  });

  // A deadline that cannot be read, or has already passed, used to be swapped for the default
  // hour with a 201: the payer got a hold it never asked for.
  test("a hold deadline that is not a time, or has already passed, is refused, never swapped for the default hour", async () => {
    const t = await newTenant("hold-deadline-odd", "pro");
    const now = () => Math.floor(Date.now() / 1000);
    const left = async () => (await req("GET", "/api/grants/verify", { token: t.token })).json.remaining.usd_cents;
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    const before = await left();
    for (const deadline of ["2026-12-25T00:00:00Z", "soon", "", "0", true, false, [], {}, [now() + 600], now() - 5, 1, -1]) {
      const r = await req("POST", "/api/escrow", { token: t.token, body: body({ deadline }) });
      expect([JSON.stringify(deadline), r.status, r.json.error]).toEqual([JSON.stringify(deadline), 400, "escrow_deadline_invalid"]);
    }
    expect(await left()).toBe(before); // the refusals held nothing
    // "Not given" is exactly: absent, null, or the number 0. Those still open the default hour.
    for (const over of [{}, { deadline: null }, { deadline: 0 }]) {
      const r = await req("POST", "/api/escrow", { token: t.token, body: body(over) });
      expect(r.status).toBe(201);
      expect(r.json.escrow.deadline).toBeGreaterThan(now() + 3500);
      expect(r.json.escrow.deadline).toBeLessThanOrEqual(now() + 3600);
    }
    // A real deadline is kept, written as a number or as a string that reads as one.
    for (const deadline of [now() + 600, String(now() + 600)]) {
      const r = await req("POST", "/api/escrow", { token: t.token, body: body({ deadline }) });
      expect(r.status).toBe(201);
      expect(r.json.escrow.deadline).toBe(Number(deadline)); // to the second
    }
  });

  // The owner's approval runs the request as it was asked. If its deadline has gone by while it
  // waited, there is nothing left to honour: it used to open a fresh one-hour hold instead.
  test("a hold whose deadline passes while it waits for the owner is refused at approval, not opened for a fresh hour", async () => {
    const t = await newTenant("hold-deadline-late", "pro");
    const now = () => Math.floor(Date.now() / 1000);
    const asker = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec: 3600, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
    });
    expect(asker.status).toBe(201);
    const left = async () => (await req("GET", "/api/grants/verify", { token: asker.json.token })).json.remaining.usd_cents;
    const intent = { amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, deadline: now() + 600 };
    const d = await req("POST", "/api/escrow", { token: asker.json.token, body: intent });
    expect(d.status).toBe(202);
    // Time passes: the same request, its deadline now behind us.
    await dbQuery("UPDATE approvals SET intent = $1::jsonb WHERE id = $2", [JSON.stringify({ ...intent, deadline: now() - 5 }), d.json.approval.id]);
    const ok = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: t.token, body: { decision: "approve" } });
    expect(ok.status).toBe(400);
    expect(ok.json.error).toBe("escrow_deadline_invalid");
    expect(await left()).toBe(500); // nothing was held
    const row = (await req("GET", "/api/approvals", { token: t.token })).json.approvals.find((a) => a.id === d.json.approval.id);
    expect(row.status).toBe("failed");
    expect((typeof row.result === "string" ? JSON.parse(row.result) : row.result).reason).toBe("escrow_deadline_invalid");
  });

  // A lifetime that is not a number was only refused when the hold was issued. For a payer whose
  // dial says "ask" that is AFTER the approval was filed: the owner was asked to approve a hold
  // that could never open.
  test("a hold lifetime that is not a number is refused before anything is filed for the owner", async () => {
    const t = await newTenant("hold-ttl-odd", "pro");
    const now = () => Math.floor(Date.now() / 1000);
    const asker = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec: 3600, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
    });
    expect(asker.status).toBe(201);
    const filed = async () => (await req("GET", "/api/approvals", { token: t.token })).json.approvals.length;
    const left = async () => (await req("GET", "/api/grants/verify", { token: t.token })).json.remaining.usd_cents;
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    const before = await left();
    for (const ttlSec of ["abc", {}, "", true, []]) {
      for (const token of [asker.json.token, t.token]) {
        const r = await req("POST", "/api/escrow", { token, body: body({ ttlSec }) });
        expect([JSON.stringify(ttlSec), r.status, r.json.error]).toEqual([JSON.stringify(ttlSec), 400, "ttl_invalid"]);
      }
    }
    // It is refused even when a good deadline is given with it (the deadline would have won).
    const both = await req("POST", "/api/escrow", { token: t.token, body: body({ deadline: now() + 600, ttlSec: "abc" }) });
    expect([both.status, both.json.error]).toEqual([400, "ttl_invalid"]);
    expect(await filed()).toBe(0); // the owner was never asked
    expect(await left()).toBe(before); // and nothing was held
    // A lifetime that is a number still works on both paths.
    const opened = await req("POST", "/api/escrow", { token: t.token, body: body({ ttlSec: "600" }) });
    expect(opened.status).toBe(201);
    expect(opened.json.escrow.deadline).toBeLessThanOrEqual(now() + 600);
    expect((await req("POST", "/api/escrow", { token: asker.json.token, body: body({ ttlSec: 600 }) })).status).toBe(202);
    expect(await filed()).toBe(1);
  });

  // No request can give a payer key an unreadable end (the column is BIGINT NOT NULL), so the
  // runtime proves this one on itself: /selftest calls the same check with such a key.
  test("a hold is refused, not waved through, when the payer key's end cannot be read", async () => {
    const r = await req("GET", "/selftest");
    const check = r.json.results.find((c) => c.name === "payment hold refused when the payer key's end cannot be read");
    expect(check).toEqual({ name: "payment hold refused when the payer key's end cannot be read", pass: true });
  });

  // The rule used where a hold's end is written (holdExpiry, policy.js): exactly the time asked,
  // refused if a limit would end it sooner. /selftest runs it with a clock that moved on between
  // the asking and the writing, which no request here can arrange.
  test("where a hold's end is written, it is the time asked or a refusal, never sooner and never later", async () => {
    const r = await req("GET", "/selftest");
    const check = r.json.results.find((c) => c.name === "payment hold ends at the time asked, or is refused, never sooner");
    expect(check).toEqual({ name: "payment hold ends at the time asked, or is refused, never sooner", pass: true });
  });

  // The tier's longest lifetime was the other thing that cut a hold short without a word: the
  // owner's key asking for 20 days on a 7-day tier got a 201 and a 7-day hold.
  test("a payment hold asked to outlast the tier's longest lifetime is refused, never quietly shortened", async () => {
    const t = await newTenant("hold-outlives-tier", "studio"); // 7 days; the owner's own key lasts longer
    const day = 86400;
    const week = 7 * day;
    const now = () => Math.floor(Date.now() / 1000);
    const left = async () => (await req("GET", "/api/grants/verify", { token: t.token })).json.remaining.usd_cents;
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    const before = await left();
    let named;
    for (const over of [{ deadline: now() + 20 * day }, { ttlSec: 20 * day }, { ttlSec: week + 1 }]) {
      const r = await req("POST", "/api/escrow", { token: t.token, body: body(over) });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("escrow_deadline_exceeds_tier_max");
      expect(r.json.detail.max_ttl_sec).toBe(week);
      expect(Math.abs(r.json.detail.latest_deadline - (now() + week))).toBeLessThanOrEqual(2);
      named = r.json.detail.latest_deadline;
    }
    expect(await left()).toBe(before); // the refusals held nothing
    // The longest the tier allows still opens: asked as a lifetime, and as the deadline the refusal named.
    const full = await req("POST", "/api/escrow", { token: t.token, body: body({ ttlSec: week }) });
    expect(full.status).toBe(201);
    expect(full.json.escrow.deadline).toBeGreaterThan(now() + week - 5);
    const byName = await req("POST", "/api/escrow", { token: t.token, body: body({ deadline: named }) });
    expect(byName.status).toBe(201);
    expect(byName.json.escrow.deadline).toBe(named);
  });

  // A key handed out on a bigger tier can outlive a move to a smaller one. Its holds follow the
  // tier the tenant is on NOW, and the refusal comes before the owner is asked anything.
  test("after a move to a smaller tier, a hold past the new limit is refused before an approval is filed", async () => {
    const t = await newTenant("hold-tier-moved", "studio");
    const day = 86400;
    const now = () => Math.floor(Date.now() / 1000);
    const asker = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec: 7 * day, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
    });
    expect(asker.status).toBe(201);
    const filed = async () => (await req("GET", "/api/approvals", { token: t.token })).json.approvals.length;
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    // On studio a 3-day hold from this key is fine: it goes to the owner.
    const waiting = await req("POST", "/api/escrow", { token: asker.json.token, body: body({ deadline: now() + 3 * day }) });
    expect(waiting.status).toBe(202);
    expect(await filed()).toBe(1);
    expect((await admin("POST", `/api/tenants/${t.id}/tier`, { body: { tier: "pro" } })).status).toBe(200); // pro: 1 day
    const r = await req("POST", "/api/escrow", { token: asker.json.token, body: body({ deadline: now() + 3 * day }) });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("escrow_deadline_exceeds_tier_max");
    expect(r.json.detail.max_ttl_sec).toBe(day);
    expect(await filed()).toBe(1); // nothing new was filed
    // The request filed before the move is held to the new limit too when the owner approves it.
    const ok = await req("POST", `/api/approvals/${waiting.json.approval.id}`, { token: t.token, body: { decision: "approve" } });
    expect(ok.status).toBe(409);
    expect(ok.json.error).toBe("escrow_deadline_exceeds_tier_max");
    expect((await req("GET", "/api/grants/verify", { token: asker.json.token })).json.remaining.usd_cents).toBe(500); // nothing was held
  });

  // The tier is read more than once while a hold opens (the key check, the hold's own check,
  // the issuing). If the tenant moves to a smaller tier between any two of those reads, the hold
  // must be refused or kept whole. It used to come back 201, cut to the smaller tier's limit.
  // One request cannot land in the middle of another here (one database session), so for this
  // test `tenants` is a view that answers studio for the first K reads of this tenant and pro
  // after that. Every K is tried, on the direct path and on the approvals path.
  test("a tier that moves while a hold is being opened never cuts the hold short", async () => {
    const t = await newTenant("hold-tier-races", "studio");
    const day = 86400;
    const now = () => Math.floor(Date.now() / 1000);
    const asker = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec: 7 * day, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
    });
    expect(asker.status).toBe(201);
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    const held = async () => (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE tenant = $1 AND sub LIKE 'escrow:%'", [t.id])).rows[0].n;
    const cols = (await dbQuery("SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
    const flipAfter = (k) => dbQuery("UPDATE tier_flip SET after = $1, seen = 0", [k]);
    const direct = [], approved = [];
    try {
      await dbQuery("CREATE TABLE tier_flip (after int NOT NULL, seen int NOT NULL)");
      await dbQuery("INSERT INTO tier_flip VALUES (1000000, 0)");
      await dbQuery(`CREATE FUNCTION tier_seen(tid text, real_tier text) RETURNS text LANGUAGE plpgsql VOLATILE AS $f$
        DECLARE flipped boolean;
        BEGIN
          IF tid <> '${t.id}' THEN RETURN real_tier; END IF;
          UPDATE tier_flip SET seen = seen + 1 RETURNING seen > after INTO flipped;
          RETURN CASE WHEN flipped THEN 'pro' ELSE real_tier END;
        END $f$`);
      await dbQuery("ALTER TABLE tenants RENAME TO tenants_real");
      await dbQuery(`CREATE VIEW tenants AS SELECT ${cols.map((c) => (c === "tier" ? "tier_seen(id, tier) AS tier" : c)).join(", ")} FROM tenants_real`);
      for (let k = 0; k <= 6; k++) {
        const before = await held();
        const asked = now() + 3 * day; // fine on studio (7 days), too long for pro (1 day)
        await flipAfter(k);
        const r = await req("POST", "/api/escrow", { token: t.token, body: body({ deadline: asked }) });
        await flipAfter(1000000);
        if (r.status === 201) {
          expect([k, r.json.escrow.deadline]).toEqual([k, asked]); // kept whole, to the second
          expect(await held()).toBe(before + 1);
        } else {
          expect([k, r.status, r.json.error]).toEqual([k, 409, "escrow_deadline_exceeds_tier_max"]);
          expect(r.json.detail.max_ttl_sec).toBe(day);
          expect(await held()).toBe(before); // refused: nothing held
        }
        direct.push(r.status);
      }
      for (let k = 0; k <= 6; k++) {
        const before = await held();
        const asked = now() + 3 * day;
        const filed = await req("POST", "/api/escrow", { token: asker.json.token, body: body({ deadline: asked }) });
        expect(filed.status).toBe(202);
        await flipAfter(k);
        const r = await req("POST", `/api/approvals/${filed.json.approval.id}`, { token: t.token, body: { decision: "approve" } });
        await flipAfter(1000000);
        if (r.status === 200) {
          expect([k, r.json.status, r.json.result.escrow.deadline]).toEqual([k, "executed", asked]);
          expect(await held()).toBe(before + 1);
        } else {
          expect([k, r.status, r.json.error]).toEqual([k, 409, "escrow_deadline_exceeds_tier_max"]);
          expect(await held()).toBe(before);
        }
        approved.push(r.status);
      }
    } finally {
      // Put the real table back whatever happened above, even a failure half-way through the swap.
      await dbQuery("DROP VIEW IF EXISTS tenants");
      if ((await dbQuery("SELECT to_regclass('tenants_real') IS NOT NULL AS there")).rows[0].there) await dbQuery("ALTER TABLE tenants_real RENAME TO tenants");
      await dbQuery("DROP FUNCTION IF EXISTS tier_seen(text, text)");
      await dbQuery("DROP TABLE IF EXISTS tier_flip");
    }
    // The sweep really crossed the window: early moves are refused, late ones (after the last
    // read) open, and once K is past the last read it stays open.
    for (const seen of [direct, approved]) {
      expect(seen[0]).toBe(409);
      expect(seen[6] === 201 || seen[6] === 200).toBe(true);
      const firstOpen = seen.findIndex((x) => x !== 409);
      expect(seen.slice(firstOpen).every((x) => x !== 409)).toBe(true);
    }
    // and the table is back: a new tenant can be made
    expect((await newTenant("hold-tier-races-after", "pro")).id).toBeTruthy();
  });

  // A tier name the runtime does not know (a wrong name in the price map, say) used to answer
  // 500 for the owner's key and file an approval that could never open for an "ask" key.
  test("no hold opens under a tier the runtime does not know, and the owner is not asked", async () => {
    const t = await newTenant("hold-tier-unknown", "pro");
    const asker = await req("POST", "/api/grants", {
      token: t.token,
      body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec: 3600, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
    });
    expect(asker.status).toBe(201);
    const body = (over) => ({ amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });
    await dbQuery("UPDATE tenants SET tier = 'bogus' WHERE id = $1", [t.id]);
    for (const token of [t.token, asker.json.token]) {
      for (const over of [{}, { ttlSec: 600 }]) {
        const r = await req("POST", "/api/escrow", { token, body: body(over) });
        expect([r.status, r.json.error]).toEqual([403, "unknown_tier"]);
      }
    }
    expect((await req("GET", "/api/approvals", { token: t.token })).json.approvals.length).toBe(0);
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE tenant = $1 AND sub LIKE 'escrow:%'", [t.id])).rows[0].n).toBe(0);
  });

  test("a lifetime that is not a number is a clean 400, not a server error", async () => {
    const t = await newTenant("ttl-odd");
    for (const ttlSec of ["abc", {}]) {
      const r = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:x", caps: ["grant.read"], ttlSec } });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("ttl_invalid");
    }
    const numeric = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:x", caps: ["grant.read"], ttlSec: "600" } });
    expect(numeric.status).toBe(201);
  });

  test("% and backslash in a memory scope are plain characters too", async () => {
    const t = await newTenant("list-literal");
    for (const partition of ["50%", "50x", "a\\b", "a\\b:c", "axb"])
      expect((await req("POST", "/api/memory", { token: t.token, body: { partition, content: partition } })).status).toBe(201);
    const key = async (partitions) =>
      (await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:reader", caps: ["memory.read"], ttlSec: 600, scope: { memory: { partitions } } } })).json.token;
    const list = async (token) => ((await req("GET", "/api/memory?limit=50", { token })).json.memories || []).map((m) => m.partition).sort();
    expect(await list(await key(["50%"]))).toEqual(["50%"]);
    expect(await list(await key(["a\\b"]))).toEqual(["a\\b", "a\\b:c"]);
  });

  // The planner used to search the WHOLE tenant for anyone allowed to plan, so its evidence
  // leaked memory the caller's key could not read.
  test("the planner's evidence comes only from memory the caller's own key may read", async () => {
    const t = await newTenant("plan-evidence");
    for (const [partition, content] of [["owner:private", "zebraquartz owner secret"], ["agent:a:", "zebraquartz agent a note"], ["agent:b:", "zebraquartz agent b note"]])
      expect((await req("POST", "/api/memory", { token: t.token, body: { partition, content } })).status).toBe(201);
    const key = async (caps, partitions) =>
      (await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:p", caps, ttlSec: 600, scope: { memory: { partitions } } } })).json.token;
    const evidence = async (token) => {
      const r = await req("POST", "/api/cog/plan", { token, body: { intent: "zebraquartz" } });
      expect(r.status).toBe(200);
      return (r.json.proposal.evidence || []).map((e) => e.partition).sort();
    };
    // may plan, may not read memory: no evidence at all
    expect(await evidence(await key(["cog.plan"], ["agent:a:"]))).toEqual([]);
    // may plan and read, but its memory scope is empty: no evidence
    expect(await evidence(await key(["cog.plan", "memory.read"], []))).toEqual([]);
    // may plan and read agent a's memory: only that
    expect(await evidence(await key(["cog.plan", "memory.read"], ["agent:a:"]))).toEqual(["agent:a:"]);
    // the owner's own key still gets all of it
    expect((await evidence(t.token)).length).toBe(3);
  });

  test("a guest cannot read another guest's memory through the planner", async () => {
    const a = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.41.1" } });
    const b = await req("POST", "/api/guest", { headers: { "x-real-ip": "10.9.42.1" } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const mine = (await req("GET", "/api/grants/verify", { token: a.json.grant })).json.scope.memory.partitions[0];
    expect((await req("POST", "/api/memory", { token: a.json.grant, body: { partition: mine, content: "quartzzebra guest a private note" } })).status).toBe(201);
    const plan = await req("POST", "/api/cog/plan", { token: b.json.grant, body: { intent: "quartzzebra" } });
    expect(plan.status).toBe(200);
    expect(JSON.stringify(plan.json)).not.toContain("guest a private note");
    expect(plan.json.proposal.evidence || []).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------
// Tours (src/tours.js, docs/specs/tours.md): more TIME for an agent without a longer key.
describe("7c. tours: an agent keeps getting a fresh 24-hour key until a date the owner set", () => {
  const DAY = 86400;
  const now = () => Math.floor(Date.now() / 1000);
  const SPEC = { agent: "report.agent", days: 3, caps: ["memory.read", "memory.write", "grant.read", "ledger.read"], budget: { usd_cents: 0, calls: 100, deploys: 0 } };
  const open = (t, over = {}) => req("POST", "/api/tours", { token: t.token, body: { ...SPEC, ...over } });
  const renew = (token) => req("POST", "/api/tours/renew", { token, body: {} });
  const works = async (token) => (await req("GET", "/api/grants", { token })).status;
  const tourOf = async (t, id) => (await req("GET", "/api/tours", { token: t.token })).json.tours.find((x) => x.id === id);
  // a renewal may not follow another within a minute: move the tour's clock back instead of waiting
  const rested = (tourId) => dbQuery("UPDATE tours SET last_renewed_at = last_renewed_at - 3600 WHERE id = $1", [tourId]);
  const reservedOf = async (grantId) => JSON.parse(JSON.stringify((await dbQuery("SELECT reserved FROM grants WHERE id = $1", [grantId])).rows[0].reserved));
  // every key that works under a tour, counted where the runtime itself looks: by parent
  const liveUnder = async (holdId) => (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1 AND status = 'active'", [holdId])).rows[0].n;
  // as if ten minutes had passed since a key was cancelled (the alarm's grace is two)
  const longAgo = (grantId) => dbQuery("UPDATE grants SET revoked_at = now() - interval '10 minutes' WHERE id = $1", [grantId]);
  // Make ONE chosen statement fail, or make something else happen at that exact moment, for the length of `fn`:
  // a database trigger that exists only inside one test. This is how a step is made to fail half way.
  const during = async (name, table, timing, when, body, fn) => {
    await dbQuery(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${body} END $f$`);
    await dbQuery(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
    try {
      return await fn();
    } finally {
      await dbQuery(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await dbQuery(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  };
  // At a chosen moment a key appears under the holding grant, as a renewal that was in hand would write one. It is
  // a copy of `likeKeyId` with nothing held, so no balance moves; only whether it WORKS afterwards is of interest.
  const keySlipsIn = (name, table, timing, when, likeKeyId, newId, fn) =>
    during(name, table, timing, when,
      `INSERT INTO grants (id, tenant, parent, depth, sub, status, caps, scope, budget, constraints, payload, iat, exp)
       SELECT '${newId}', tenant, parent, depth, sub, 'active', caps, scope, '{"usd_cents":0,"calls":0,"deploys":0}'::jsonb, constraints, payload, iat, exp FROM grants WHERE id = '${likeKeyId}'; RETURN NEW;`,
      fn);
  const statusOf = async (grantId) => (await dbQuery("SELECT status FROM grants WHERE id = $1", [grantId])).rows[0]?.status;
  const cannotCancel = (name, grantId, fn) => during(name, "grants", "BEFORE UPDATE", `OLD.id = '${grantId}' AND NEW.status = 'revoked'`, "RAISE EXCEPTION 'test: this key cannot be cancelled right now';", fn);

  test("the owner opens a tour: the stay is days long, the key is 24 hours at most, and it opens only that agent's memory", async () => {
    const t = await newTenant("tour-open", "studio");
    const r = await open(t);
    expect(r.status).toBe(201);
    const { tour, key, receipt } = r.json;
    expect(tour.status).toBe("active");
    expect(tour.agent).toBe("report.agent");
    expect(tour.until).toBeGreaterThan(now() + 3 * DAY - 60);
    expect(tour.until).toBeLessThanOrEqual(now() + 3 * DAY);
    expect(tour.key.id).toBe(key.id);
    expect(tour.live_keys).toBe(1);
    expect(key.exp).toBeLessThanOrEqual(now() + DAY); // the KEY is never longer than a day
    expect(key.exp).toBeGreaterThan(now() + DAY - 60);
    expect(key.sub).toBe("agent:report.agent");
    expect(key.caps).toEqual(SPEC.caps);
    expect(key.budget.calls).toBe(100);
    expect(receipt.tour).toBe(tour.id);
    expect(receipt.first_key).toBe(key.id);
    expect(receipt.until).toBe(tour.until);
    expect(receipt.limited_by).toBe("asked");
    // exactly ONE key is handed out: the holding grant's token is never in the answer
    expect(r.text.match(/cog1\./g).length).toBe(1);
    expect(await works(key.token)).toBe(200);
    // its memory is the section kept under the agent's NAME, and no other
    expect((await req("POST", "/api/memory", { token: key.token, body: { partition: "agent:report.agent:", key: "k", content: "mine" } })).status).toBe(201);
    expect((await req("POST", "/api/memory", { token: key.token, body: { partition: "agent:report.agent2:", key: "k", content: "not mine" } })).status).toBe(403);
    expect((await req("GET", "/api/memory?partition=tenant", { token: key.token })).status).toBe(403);
  });

  test("a tour that must end sooner than asked says so: the owner's own key ends first", async () => {
    const t = await newTenant("tour-short-owner", "studio");
    const ownerEnds = now() + 2 * DAY;
    await dbQuery("UPDATE grants SET exp = $2 WHERE id = $1", [t.grantId, ownerEnds]);
    const r = await open(t, { days: 3 });
    expect(r.status).toBe(201);
    expect(r.json.receipt.limited_by).toBe("owner_key");
    expect(r.json.receipt.until).toBe(ownerEnds);
    expect(r.json.tour.until).toBe(ownerEnds);
    const note = (await req("GET", "/api/ledger", { token: t.token })).json.ledger.find((l) => l.kind === "tour-open").note;
    expect(note).toContain("asked 3 day(s)");
    expect(note).toContain("sooner");
  });

  test("the holding grant is a record, never a credential: even a token minted for it by the admin is refused", async () => {
    const t = await newTenant("tour-holder", "studio");
    const r = await open(t);
    const minted = await admin("POST", `/api/admin/grants/${r.json.receipt.holding_grant}/token`);
    expect(minted.status).toBe(200);
    const use = await req("GET", "/api/tenant", { token: minted.json.token });
    expect(use.status).toBe(401);
    expect(use.json.error).toBe("holding_grant");
    expect((await req("POST", "/api/grants", { token: minted.json.token, body: { sub: "agent:x", caps: ["grant.read"] } })).status).toBe(401);
    expect((await renew(minted.json.token)).status).toBe(401);
  });

  test("an old token for the holding grant cannot end an extended tour early: the row's end decides, not the token's", async () => {
    const t = await newTenant("tour-old-token", "studio");
    const first = (await open(t, { days: 2 })).json;
    const hold = first.receipt.holding_grant;
    // the token text says it ended an hour ago; the row (as after an extension) says it has days to go
    await dbQuery("UPDATE grants SET payload = jsonb_set(payload::jsonb, '{exp}', to_jsonb($2::bigint))::text WHERE id = $1", [hold, now() - 3600]);
    const stale = (await admin("POST", `/api/admin/grants/${hold}/token`)).json.token;
    // with no key working under it, nothing but the end date stands between that token and ending the tour
    expect((await admin("POST", `/api/admin/grants/${first.key.id}/revoke`, { body: { reason: "test: key lost" } })).status).toBe(200);
    const use = await req("GET", "/api/tenant", { token: stale });
    expect(use.status).toBe(401);
    expect(use.json.error).toBe("grant_expired");
    expect((await dbQuery("SELECT status FROM grants WHERE id = $1", [hold])).rows[0].status).toBe("active");
    const fresh = await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} });
    expect(fresh.status).toBe(201);
    expect(fresh.json.key.budget.calls).toBe(100);
  });

  test("only the owner opens a tour, and a bad request holds nothing", async () => {
    const t = await newTenant("tour-refuse", "studio");
    const before = await reservedOf(t.grantId);
    const helper = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:helper", caps: ["grant.issue", "grant.read", "memory.read"], ttlSec: 3600, budget: { usd_cents: 0, calls: 10, deploys: 0 } } });
    const mid = await reservedOf(t.grantId);
    const notOwner = await req("POST", "/api/tours", { token: helper.json.token, body: SPEC });
    expect(notOwner.status).toBe(403);
    expect(notOwner.json.error).toBe("owner_required");
    for (const [over, error] of [
      [{ agent: "Report Agent" }, "tour_agent_required"], [{ agent: "" }, "tour_agent_required"], [{ agent: "../x" }, "tour_agent_required"], [{ agent: "a:b" }, "tour_agent_required"], [{ agent: ["report"] }, "tour_agent_required"],
      [{ days: 0 }, "tour_days_invalid"], [{ days: 8 }, "tour_days_invalid"], [{ days: 1.5 }, "tour_days_invalid"], [{ days: "3" }, "tour_days_invalid"], [{ days: undefined }, "tour_days_invalid"],
      [{ caps: [] }, "tour_caps_required"], [{ caps: "memory.read" }, "tour_caps_required"], [{ caps: [1] }, "tour_caps_required"],
      [{ budget: undefined }, "tour_budget_required"], [{ budget: { usd_cents: 0, calls: 0, deploys: 0 } }, "tour_budget_required"], [{ budget: [100] }, "tour_budget_required"],
    ]) {
      const r = await open(t, over);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe(error);
    }
    // powers the owner's own key does not have, or more money than it has, are refused by the ordinary rule
    expect((await open(t, { caps: ["memory.read", "not.a.cap"] })).status).toBe(403);
    expect((await open(t, { budget: { usd_cents: 99999999, calls: 1, deploys: 0 } })).status).toBeGreaterThanOrEqual(402);
    expect(await reservedOf(t.grantId)).toEqual(mid); // none of the refusals left anything held
    expect(mid.calls).toBe(before.calls + 10);
    // a tier that allows keys of one day cannot be given a three-day stay
    const pro = await newTenant("tour-tier", "pro");
    const tooLong = await open(pro);
    expect(tooLong.status).toBe(403);
    expect(tooLong.json.error).toBe("tour_exceeds_tier");
    expect(tooLong.json.detail.max_days).toBe(1);
    // one tour per agent name
    expect((await open(t)).status).toBe(201);
    const again = await open(t);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("tour_exists");
    expect((await open(t, { agent: "other.agent" })).status).toBe(201);
  });

  test("opening: if the tour cannot be recorded nothing stays held, and two opens at the same moment cannot both win", async () => {
    const t = await newTenant("tour-open-fail", "studio");
    const before = await reservedOf(t.grantId);
    const below = async () => (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE tenant = $1 AND status = 'active' AND depth > 0", [t.id])).rows[0].n;
    const liveTours = async () => (await dbQuery("SELECT count(*)::int AS n FROM tours WHERE tenant = $1 AND agent = $2 AND status IN ('active', 'frozen')", [t.id, SPEC.agent])).rows[0].n;
    // the record cannot be written at all: no holding grant is left behind holding the owner's budget
    const failed = await during("tr_tour_insert_fails", "tours", "BEFORE INSERT", `NEW.tenant = '${t.id}'`, "RAISE EXCEPTION 'test: the tour cannot be recorded';", () => open(t));
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain("cog1.");
    expect(await reservedOf(t.grantId)).toEqual(before);
    expect(await below()).toBe(0);
    // the other open got its record in first (the look before the insert saw nothing): the table itself refuses the second
    const lost = await during("tr_tour_insert_dup", "tours", "BEFORE INSERT", `NEW.tenant = '${t.id}'`, "RAISE EXCEPTION 'duplicate key value violates unique constraint \"tours_one_live_per_agent\"' USING ERRCODE = 'unique_violation';", () => open(t));
    expect(lost.status).toBe(409);
    expect(lost.json.error).toBe("tour_exists");
    expect(await reservedOf(t.grantId)).toEqual(before);
    expect(await below()).toBe(0);
    // and for real: two at once
    const both = await Promise.all([open(t), open(t)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(both.find((r) => r.status === 409).json.error).toBe("tour_exists");
    expect(await liveTours()).toBe(1);
    expect(await below()).toBe(2); // one holding grant and its one key
    expect((await reservedOf(t.grantId)).calls).toBe(before.calls + 100); // one tour's budget held, not two
    // the rule is the table's own, not only a look before the insert
    const winner = both.find((r) => r.status === 201).json;
    await expect(
      dbQuery("INSERT INTO tours (id, tenant, grant_id, agent, status, opened_at, until, last_renewed_at) VALUES ('tr_second', $1, $2, $3, 'active', 0, 0, 0)", [t.id, winner.receipt.holding_grant, SPEC.agent]),
    ).rejects.toThrow();
  });

  test("renewing: the old key stops, the new one works, and time never refills money", async () => {
    const t = await newTenant("tour-renew", "studio");
    const first = (await open(t)).json;
    expect((await req("POST", "/api/grants/settle", { token: first.key.token, body: { calls: 30, ref: "work:day1" } })).status).toBe(200);
    const soon = await renew(first.key.token);
    expect(soon.status).toBe(429); // not twice within a minute
    expect(soon.json.error).toBe("tour_renew_too_soon");
    expect(await works(first.key.token)).toBe(200); // a refused renewal changes nothing
    await rested(first.tour.id);
    const second = await renew(first.key.token);
    expect(second.status).toBe(201);
    expect(second.json.key.id).not.toBe(first.key.id);
    expect(second.json.key.exp).toBeLessThanOrEqual(now() + DAY);
    expect(second.json.key.budget.calls).toBe(70); // 100 at the start, 30 spent on day one
    expect(second.json.tour.renewals).toBe(1);
    expect(second.json.tour.left.calls).toBe(70);
    expect(second.json.tour.key.id).toBe(second.json.key.id);
    expect(second.json.receipt.replaced_key).toBe(first.key.id);
    expect(await works(first.key.token)).toBe(401);
    expect(await works(second.json.key.token)).toBe(200);
    expect(await liveUnder(first.receipt.holding_grant)).toBe(1);
    // the same memory, the moment the new key exists
    expect((await req("POST", "/api/memory", { token: second.json.key.token, body: { partition: "agent:report.agent:", key: "day2", content: "carried on" } })).status).toBe(201);
    // the old key cannot renew again, and neither can a key that is not a tour's current key
    expect((await renew(first.key.token)).status).toBe(401);
    expect((await renew(t.token)).status).toBe(404);
    const plain = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:plain", caps: ["grant.read"], ttlSec: 600 } });
    const notTour = await renew(plain.json.token);
    expect(notTour.status).toBe(404);
    expect(notTour.json.error).toBe("not_a_tour_key");
    // two renewals with the same key at the same moment: exactly one new key. Never two, and never none.
    // (Many times over, a little apart each time: which one reads the tour first must not matter.)
    let key = second.json.key;
    for (let i = 0; i < 12; i++) {
      await rested(first.tour.id);
      const token = key.token;
      const pair = await Promise.all([renew(token), new Promise((r) => setTimeout(r, i % 5)).then(() => renew(token))]);
      expect(pair.filter((r) => r.status === 201).length).toBe(1);
      expect(pair.filter((r) => r.status !== 201).every((r) => [401, 409].includes(r.status) && !r.text.includes("cog1."))).toBe(true);
      expect(await liveUnder(first.receipt.holding_grant)).toBe(1);
      key = pair.find((r) => r.status === 201).json.key;
      expect(await works(key.token)).toBe(200);
      expect(key.budget.calls).toBe(70);
    }
    expect((await tourOf(t, first.tour.id)).status).toBe("active");
  }, 60000);

  test("a renewal that fails at its first step changes nothing: the key still works and can renew", async () => {
    const t = await newTenant("tour-renew-fail", "studio");
    const first = (await open(t)).json;
    await rested(first.tour.id);
    const failed = await cannotCancel("tr_renew_cancel_fails", first.key.id, () => renew(first.key.token));
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain("cog1.");
    // nothing moved: the tour still points at the key, the key still works, and no other key exists
    expect(await works(first.key.token)).toBe(200);
    const tour = await tourOf(t, first.tour.id);
    expect(tour.status).toBe("active");
    expect(tour.key.id).toBe(first.key.id);
    expect(tour.live_keys).toBe(1);
    const second = await renew(first.key.token);
    expect(second.status).toBe(201);
    expect(second.json.key.budget.calls).toBe(100);
    expect(await works(first.key.token)).toBe(401);
  });

  test("the alarm: a key that a renewal replaced, used again later, freezes the tour until the owner steps in", async () => {
    const t = await newTenant("tour-alarm", "studio");
    const first = (await open(t, { caps: [...SPEC.caps, "grant.issue"] })).json;
    const helper = await req("POST", "/api/grants", { token: first.key.token, body: { sub: "agent:helper", caps: ["grant.read"], ttlSec: 600, budget: { usd_cents: 0, calls: 5, deploys: 0 } } });
    expect(helper.status).toBe(201);
    await rested(first.tour.id);
    const second = (await renew(first.key.token)).json;
    // straight after the renewal the old key is simply refused: a call that was already on its way is not an alarm
    expect(await works(first.key.token)).toBe(401);
    expect(await works(second.key.token)).toBe(200);
    expect((await tourOf(t, first.tour.id)).status).toBe("active");
    // a helper the old key had hired is gone with it, and ITS late use is not the alarm either
    await longAgo(helper.json.id);
    expect(await works(helper.json.token)).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("active");
    // a day later the agent renews again, so two replaced keys now exist
    await rested(first.tour.id);
    const third = (await renew(second.key.token)).json;
    // ten minutes later the FIRST replaced key turns up again: somebody else has a copy
    await longAgo(first.key.id);
    expect(await works(first.key.token)).toBe(401);
    const frozen = await tourOf(t, first.tour.id);
    expect(frozen.status).toBe("frozen");
    expect(frozen.frozen_reason).toContain("used again");
    expect(frozen.live_keys).toBe(0);
    expect(await works(third.key.token)).toBe(401); // the current key is cancelled with it
    expect((await renew(third.key.token)).status).toBe(401);
    // only the owner can put it right, and then the agent carries on with what the tour has left
    const fresh = await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} });
    expect(fresh.status).toBe(201);
    expect(fresh.json.tour.status).toBe("active");
    expect(fresh.json.key.budget.calls).toBe(100);
    expect(await works(fresh.json.key.token)).toBe(200);
    // the same dead key cannot freeze the tour a second time: it raised its alarm once
    expect(await works(first.key.token)).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("active");
    // nor can the OTHER key that was replaced before the owner looked: the reissue started the tour afresh
    await longAgo(second.key.id);
    expect(await works(second.key.token)).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("active");
    expect(await works(fresh.json.key.token)).toBe(200);
    // but the alarm itself is still set: the next key to be replaced and used late raises it again
    await rested(first.tour.id);
    const fourth = (await renew(fresh.json.key.token)).json;
    await longAgo(fresh.json.key.id);
    expect(await works(fresh.json.key.token)).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("frozen");
    expect(await works(fourth.key.token)).toBe(401);
    const ledger = (await req("GET", "/api/ledger", { token: t.token })).json.ledger;
    for (const k of ["tour-open", "tour-renew", "tour-freeze", "tour-reissue"]) expect(ledger.map((l) => l.kind)).toContain(k);
    expect(ledger.filter((l) => l.kind === "tour-freeze").length).toBe(2); // one line per freeze, not one per use of the dead key
    const events = (await admin("GET", "/api/admin/events")).json.events.map((e) => e.type);
    for (const e of ["tour.opened", "tour.renewed", "tour.frozen", "tour.reissued"]) expect(events).toContain(e);
  });

  test("a freeze that lands in the middle of a renewal: the renewal is refused and no key is left working", async () => {
    const t = await newTenant("tour-freeze-mid", "studio");
    const first = (await open(t)).json;
    const hold = first.receipt.holding_grant;
    await rested(first.tour.id);
    // the moment the next key is written, the tour is frozen (exactly what the alarm does), before the renewal can hand the key over
    const r = await during(
      "tr_freeze_mid_renewal", "grants", "AFTER INSERT", `NEW.parent = '${hold}'`,
      `UPDATE tours SET status = 'frozen', frozen_reason = 'test: frozen in the middle of a renewal', current_key = NULL WHERE id = '${first.tour.id}'; RETURN NULL;`,
      () => renew(first.key.token),
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("tour_frozen");
    expect(r.text).not.toContain("cog1."); // no key is handed out
    expect(await liveUnder(hold)).toBe(0); // and the one that was written does not work
    expect(await works(first.key.token)).toBe(401);
    const tour = await tourOf(t, first.tour.id);
    expect(tour.status).toBe("frozen");
    expect(tour.renewals).toBe(0);
    expect(tour.left.calls).toBe(100);
    expect((await reservedOf(hold)).calls).toBe(0); // nothing is held under the tour any more
    // The other way round: the renewal's key is written just as the alarm marks the tour frozen, after the alarm has
    // already cancelled what it found. The alarm looks under the tour once more before it is done.
    const u = await newTenant("tour-freeze-mid-2", "studio");
    const one = (await open(u)).json;
    await rested(one.tour.id);
    const two = (await renew(one.key.token)).json;
    await longAgo(one.key.id);
    await keySlipsIn("tr_key_slips_in_at_freeze", "tours", "AFTER UPDATE", `NEW.id = '${one.tour.id}' AND NEW.status = 'frozen' AND OLD.status = 'active'`, two.key.id, "gr_slipped_freeze", async () => {
      expect(await works(one.key.token)).toBe(401); // the alarm
    });
    // (looked at in the table first: the owner's list would itself sweep a frozen tour clean)
    expect(await statusOf("gr_slipped_freeze")).toBe("revoked");
    expect(await liveUnder(one.receipt.holding_grant)).toBe(0);
    expect((await tourOf(u, one.tour.id)).status).toBe("frozen");
  });

  test("a tour never reads frozen while a key under it still works", async () => {
    const t = await newTenant("tour-freeze-fail", "studio");
    const first = (await open(t)).json;
    const hold = first.receipt.holding_grant;
    await rested(first.tour.id);
    const second = (await renew(first.key.token)).json;
    await longAgo(first.key.id);
    // the alarm goes off but the current key cannot be cancelled: the tour must not claim to be frozen
    await cannotCancel("tr_freeze_cancel_fails", second.key.id, async () => {
      expect(await works(first.key.token)).toBe(401);
      expect((await tourOf(t, first.tour.id)).status).toBe("active");
      expect(await works(second.key.token)).toBe(200);
    });
    // the very next use of the old key tries again, and this time finishes
    expect(await works(first.key.token)).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("frozen");
    expect(await works(second.key.token)).toBe(401);
    expect(await liveUnder(hold)).toBe(0);
    // Backstop: a tour that IS marked frozen with a key still working under it (the mark was written and the last
    // cancel then failed) is put right by the sweep, whether or not the old key is ever used again.
    const fresh = (await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} })).json;
    await dbQuery("UPDATE tours SET status = 'frozen', current_key = NULL WHERE id = $1", [first.tour.id]);
    expect(await works(fresh.key.token)).toBe(200);
    expect((await admin("POST", "/api/admin/grants/reap")).status).toBe(200);
    expect(await works(fresh.key.token)).toBe(401);
    expect(await liveUnder(hold)).toBe(0);
    expect((await tourOf(t, first.tour.id)).status).toBe("frozen"); // still the owner's to put right
  });

  test("a key the tour lost sight of is cancelled at the next reissue, and the new key gets everything the tour has left", async () => {
    const t = await newTenant("tour-stray", "studio");
    const first = (await open(t)).json;
    // as if a step had died half way: a key works under the tour, and the tour's own note of it is gone
    await dbQuery("UPDATE tours SET current_key = NULL WHERE id = $1", [first.tour.id]);
    const lost = await tourOf(t, first.tour.id);
    expect(lost.status).toBe("key_run_out");
    expect(lost.key).toBe(null);
    expect(lost.live_keys).toBe(1); // counted, not hidden
    expect(await works(first.key.token)).toBe(200);
    expect((await renew(first.key.token)).status).toBe(404); // it is not the tour's current key
    const fresh = await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} });
    expect(fresh.status).toBe(201);
    expect(fresh.json.key.budget.calls).toBe(100); // not 0: what the lost key held came back first
    expect(await works(first.key.token)).toBe(401);
    expect(fresh.json.tour.live_keys).toBe(1);
    expect(await liveUnder(first.receipt.holding_grant)).toBe(1);
    // the same when the alarm goes off: every key under the tour stops, whichever one the tour's note points at
    await rested(first.tour.id);
    const next = (await renew(fresh.json.key.token)).json;
    await dbQuery("UPDATE tours SET current_key = NULL WHERE id = $1", [first.tour.id]);
    await longAgo(fresh.json.key.id);
    expect(await works(fresh.json.key.token)).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("frozen");
    expect(await works(next.key.token)).toBe(401);
    // and when the tour is ended
    const again = (await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} })).json;
    await dbQuery("UPDATE tours SET current_key = NULL WHERE id = $1", [first.tour.id]);
    expect((await req("POST", `/api/tours/${first.tour.id}/end`, { token: t.token, body: {} })).status).toBe(200);
    expect(await works(again.key.token)).toBe(401);
  });

  test("a cancel reason somebody wrote by hand is not the alarm", async () => {
    const t = await newTenant("tour-spoof", "studio");
    const first = (await open(t)).json;
    // the tour's CURRENT key, cancelled through the ordinary route with the very words a renewal writes
    expect((await req("POST", `/api/grants/${first.key.id}/revoke`, { token: t.token, body: { reason: "tour: renewed" } })).status).toBe(200);
    await longAgo(first.key.id);
    expect(await works(first.key.token)).toBe(401);
    const tour = await tourOf(t, first.tour.id);
    expect(tour.status).toBe("key_run_out"); // not frozen: no renewal ever replaced that key
    expect((await req("GET", "/api/ledger", { token: t.token })).json.ledger.map((l) => l.kind)).not.toContain("tour-freeze");
    expect((await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} })).status).toBe(201);
  });

  test("a key that ran out can be reissued by the owner only, and a tour left alone for two days is finished", async () => {
    const t = await newTenant("tour-lapse", "studio");
    const before = await reservedOf(t.grantId);
    const first = (await open(t)).json;
    // the key is cancelled from outside (the kill switch for one agent): the tour's record remains
    expect((await admin("POST", `/api/admin/grants/${first.key.id}/revoke`, { body: { reason: "test: key lost" } })).status).toBe(200);
    expect((await renew(first.key.token)).status).toBe(401);
    expect((await tourOf(t, first.tour.id)).status).toBe("key_run_out");
    const helper = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:helper", caps: ["grant.issue", "grant.read"], ttlSec: 600 } });
    expect((await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: helper.json.token, body: {} })).status).toBe(403);
    const fresh = await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} });
    expect(fresh.status).toBe(201);
    expect(await works(fresh.json.key.token)).toBe(200);
    expect((await req("POST", "/api/grants/settle", { token: fresh.json.key.token, body: { calls: 10, ref: "work:1" } })).status).toBe(200);
    // nobody renews for more than 48 hours: the sweep that runs with the reaper ends it, nobody has to ask
    await dbQuery("UPDATE tours SET last_renewed_at = last_renewed_at - $2 WHERE id = $1", [first.tour.id, 49 * 3600]);
    expect(await works(fresh.json.key.token)).toBe(200); // until the sweep comes round
    const swept = await admin("POST", "/api/admin/grants/reap");
    expect(swept.json.tours_ended).toContain(first.tour.id);
    const ended = await tourOf(t, first.tour.id);
    expect(ended.status).toBe("ended");
    expect(ended.ended_reason).toContain("idle");
    expect(await works(fresh.json.key.token)).toBe(401);
    expect((await reservedOf(t.grantId)).calls).toBe(before.calls + 10); // everything it had not spent is back with the owner
    expect((await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} })).json.error).toBe("tour_ended");
    expect((await admin("POST", "/api/admin/grants/reap")).json.tours_ended).not.toContain(first.tour.id); // ended once
    expect((await open(t)).status).toBe(201); // and a new tour for the same name can be opened
  });

  test("a tour whose end date has passed, or whose holding grant was cancelled from outside, is finished and frees the name", async () => {
    const t = await newTenant("tour-over", "studio");
    const before = await reservedOf(t.grantId);
    const a = (await open(t, { agent: "agent.a" })).json;
    const b = (await open(t, { agent: "agent.b" })).json;
    // a: its end date passes (the key ends with it: a key never outlives the tour)
    await dbQuery("UPDATE tours SET until = $2 WHERE id = $1", [a.tour.id, now() - 5]);
    await dbQuery("UPDATE grants SET exp = $2 WHERE id IN ($1, $3)", [a.receipt.holding_grant, now() - 5, a.key.id]);
    // nothing has swept yet, and the owner opens the name again at once: the finished tour is ended first, not in the way
    expect((await tourOf(t, a.tour.id)).status).toBe("ended");
    const a2 = await open(t, { agent: "agent.a" });
    expect(a2.status).toBe(201);
    expect((await req("POST", `/api/tours/${a2.json.tour.id}/end`, { token: t.token, body: {} })).status).toBe(200);
    // b: the owner cancels the holding grant through the ordinary route, not through the tour
    expect((await req("POST", `/api/grants/${b.receipt.holding_grant}/revoke`, { token: t.token, body: { reason: "test: cancelled from outside" } })).status).toBe(200);
    expect(await works(b.key.token)).toBe(401);
    const swept = (await admin("POST", "/api/admin/grants/reap")).json;
    expect(swept.tours_ended).not.toContain(a.tour.id); // ended already, when the owner looked
    expect(swept.tours_ended).toContain(b.tour.id);
    const [ta, tb] = [await tourOf(t, a.tour.id), await tourOf(t, b.tour.id)];
    expect(ta.status).toBe("ended");
    expect(ta.ended_reason).toContain("end date");
    expect(tb.status).toBe("ended");
    expect(tb.ended_reason).toContain("holding grant");
    expect(await reservedOf(t.grantId)).toEqual(before);
    expect((await open(t, { agent: "agent.a" })).status).toBe(201);
    expect((await open(t, { agent: "agent.b" })).status).toBe(201);
    // without the sweep too: the owner looking at the list, or opening the name again, finds it finished
    const c = (await open(t, { agent: "agent.c" })).json;
    expect((await req("POST", `/api/grants/${c.receipt.holding_grant}/revoke`, { token: t.token, body: {} })).status).toBe(200);
    expect((await open(t, { agent: "agent.c" })).status).toBe(201);
    expect((await tourOf(t, c.tour.id)).status).toBe("ended");
    // A key written under the holding grant at the very moment that grant was cancelled used to be missed by the
    // cancel (grants.js: the gap closed on 2026-10-09). The state it left is written here by hand: the holding grant
    // cancelled, its key not. The key stops WORKING at once, because a grant above it has ended (grants.js,
    // endedAbove; before that it answered 200). It is still there, though, until ending the tour looks under it.
    const d = (await open(t, { agent: "agent.d" })).json;
    await dbQuery("UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'test: cancelled, one key missed' WHERE id = $1", [d.receipt.holding_grant]);
    expect(await works(d.key.token)).toBe(401);
    expect(await liveUnder(d.receipt.holding_grant)).toBe(1);
    expect((await admin("POST", "/api/admin/grants/reap")).json.tours_ended).toContain(d.tour.id);
    expect(await works(d.key.token)).toBe(401);
    expect(await liveUnder(d.receipt.holding_grant)).toBe(0);
    // and the same moment for real: a key is written under the holding grant just as the owner ends the tour
    const e = (await open(t, { agent: "agent.e" })).json;
    const end = await keySlipsIn("tr_key_slips_in_at_end", "grants", "BEFORE UPDATE", `OLD.id = '${e.receipt.holding_grant}' AND OLD.status = 'active' AND NEW.status = 'revoked'`, e.key.id, "gr_slipped_end",
      () => req("POST", `/api/tours/${e.tour.id}/end`, { token: t.token, body: {} }));
    expect(end.status).toBe(200);
    expect(end.json.receipt.cancelled_keys).toBe(3); // the holding grant, its key, and the one that slipped in
    expect(await statusOf("gr_slipped_end")).toBe("revoked");
    expect(await liveUnder(e.receipt.holding_grant)).toBe(0);
  });

  test("what a tour has left is its budget less everything used under it, whoever used it and whatever state the keys are in", async () => {
    const t = await newTenant("tour-left", "studio");
    const first = (await open(t, { caps: [...SPEC.caps, "grant.issue"] })).json;
    const helper = await req("POST", "/api/grants", { token: first.key.token, body: { sub: "agent:helper", caps: ["grant.read"], ttlSec: 600, budget: { usd_cents: 0, calls: 20, deploys: 0 } } });
    expect(helper.status).toBe(201);
    expect((await req("POST", "/api/grants/settle", { token: helper.json.token, body: { calls: 5, ref: "help:1" } })).status).toBe(200);
    expect((await req("POST", "/api/grants/settle", { token: first.key.token, body: { calls: 10, ref: "work:1" } })).status).toBe(200);
    expect((await tourOf(t, first.tour.id)).left.calls).toBe(85); // 100 - 10 by the key - 5 by its helper
    // the key runs out and nothing has swept it yet: it still holds its share, but nothing more was used
    await dbQuery("UPDATE grants SET exp = $3 WHERE id IN ($1, $2)", [first.key.id, helper.json.id, now() - 5]);
    const idle = await tourOf(t, first.tour.id);
    expect(idle.status).toBe("key_run_out");
    expect(idle.left.calls).toBe(85);
    // the owner reissues: the next key gets exactly that
    const fresh = await req("POST", `/api/tours/${first.tour.id}/reissue`, { token: t.token, body: {} });
    expect(fresh.status).toBe(201);
    expect(fresh.json.key.budget.calls).toBe(85);
    expect(fresh.json.tour.left.calls).toBe(85);
  });

  test("extending (a furlough) adds days, never money, and stops at each limit", async () => {
    const t = await newTenant("tour-extend", "studio");
    const first = (await open(t, { days: 2 })).json;
    const hold = first.receipt.holding_grant;
    const more = await req("POST", `/api/tours/${first.tour.id}/extend`, { token: t.token, body: { days: 3 } });
    expect(more.status).toBe(200);
    expect(more.json.tour.until).toBe(first.tour.until + 3 * DAY);
    expect(more.json.tour.budget).toEqual(first.tour.budget);
    expect(more.json.tour.left.calls).toBe(100);
    expect(more.json.receipt.limited_by).toBe("asked");
    expect(Number((await dbQuery("SELECT exp FROM grants WHERE id = $1", [hold])).rows[0].exp)).toBe(more.json.tour.until); // the record and the grant moved together
    // the next key reaches into the added days; the current key was not made longer
    await rested(first.tour.id);
    expect((await renew(first.key.token)).json.key.exp).toBeLessThanOrEqual(now() + DAY);
    // one signature never reaches more than 7 days ahead
    const capped = await req("POST", `/api/tours/${first.tour.id}/extend`, { token: t.token, body: { days: 7 } });
    expect(capped.status).toBe(200);
    expect(capped.json.receipt.limited_by).toBe("one_signature");
    expect(capped.json.tour.until).toBeLessThanOrEqual(now() + 7 * DAY);
    // at the limit already: the seconds that have passed since are not an extension, and leave no receipt
    const lines = async () => (await req("GET", "/api/ledger", { token: t.token })).json.ledger.filter((l) => l.kind === "tour-extend").length;
    const had = await lines();
    await dbQuery("UPDATE tours SET until = until - 600 WHERE id = $1", [first.tour.id]); // even ten minutes short of it
    const atLimit = await req("POST", `/api/tours/${first.tour.id}/extend`, { token: t.token, body: { days: 1 } });
    expect(atLimit.status).toBe(409);
    expect(atLimit.json.error).toBe("tour_at_limit");
    expect(atLimit.json.detail.limits.one_signature).toBeGreaterThan(0);
    expect(await lines()).toBe(had);
    // 30 days in all: a tour opened 29 days ago can only be taken to its 30th day
    await dbQuery("UPDATE tours SET opened_at = opened_at - $2, until = $3 WHERE id = $1", [first.tour.id, 29 * DAY, now() + 3600]);
    await dbQuery("UPDATE grants SET exp = $2 WHERE id = $1", [hold, now() + 3600]);
    const last = await req("POST", `/api/tours/${first.tour.id}/extend`, { token: t.token, body: { days: 5 } });
    expect(last.status).toBe(200);
    expect(last.json.receipt.limited_by).toBe("whole_tour");
    expect(last.json.tour.until).toBeLessThanOrEqual(now() + DAY + 60);
    for (const days of [0, 8, 2.5, "2", null]) expect((await req("POST", `/api/tours/${first.tour.id}/extend`, { token: t.token, body: { days } })).json.error).toBe("tour_days_invalid");
    const helper = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:helper", caps: ["grant.issue", "grant.read"], ttlSec: 600 } });
    expect((await req("POST", `/api/tours/${first.tour.id}/extend`, { token: helper.json.token, body: { days: 1 } })).status).toBe(403);
    const other = await newTenant("tour-extend-other", "studio");
    expect((await req("POST", `/api/tours/${first.tour.id}/extend`, { token: other.token, body: { days: 1 } })).status).toBe(404); // another tenant cannot even see it
  });

  test("ending a tour stops the agent at once and gives back what it had not spent", async () => {
    const t = await newTenant("tour-end", "studio");
    const before = await reservedOf(t.grantId);
    const first = (await open(t)).json;
    expect((await req("POST", "/api/grants/settle", { token: first.key.token, body: { calls: 25, ref: "work:1" } })).status).toBe(200);
    const helper = await req("POST", "/api/grants", { token: t.token, body: { sub: "agent:helper", caps: ["grant.issue", "grant.read"], ttlSec: 600 } });
    expect((await req("POST", `/api/tours/${first.tour.id}/end`, { token: helper.json.token, body: {} })).status).toBe(403);
    expect((await req("POST", `/api/tours/${first.tour.id}/end`, { token: first.key.token, body: {} })).status).toBe(403); // not even the tour's own key
    const end = await req("POST", `/api/tours/${first.tour.id}/end`, { token: t.token, body: {} });
    expect(end.status).toBe(200);
    expect(end.json.tour.status).toBe("ended");
    expect(end.json.tour.ended_reason).toContain("owner");
    expect(end.json.receipt.cancelled_keys).toBe(2); // the holding grant and its one key
    expect(await works(first.key.token)).toBe(401);
    expect((await renew(first.key.token)).status).toBe(401);
    expect((await reservedOf(t.grantId)).calls).toBe(before.calls + 25); // only what was really spent stays counted
    expect((await req("POST", `/api/tours/${first.tour.id}/end`, { token: t.token, body: {} })).json.error).toBe("tour_ended");
    expect((await req("POST", `/api/tours/${first.tour.id}/extend`, { token: t.token, body: { days: 1 } })).json.error).toBe("tour_ended");
    expect((await req("POST", "/api/tours/tr_nope/end", { token: t.token, body: {} })).status).toBe(404);
  });

  test("the owner sees every tour; a tour's key sees its own and no other", async () => {
    const t = await newTenant("tour-list", "studio");
    const a = (await open(t, { agent: "agent.a" })).json;
    const b = (await open(t, { agent: "agent.b" })).json;
    const all = (await req("GET", "/api/tours", { token: t.token })).json.tours;
    expect(all.map((x) => x.agent).sort()).toEqual(["agent.a", "agent.b"]);
    const mine = (await req("GET", "/api/tours", { token: a.key.token })).json.tours;
    expect(mine.length).toBe(1);
    expect(mine[0].id).toBe(a.tour.id);
    expect(JSON.stringify(mine)).not.toContain(b.tour.id);
    const other = await newTenant("tour-list-other", "studio");
    expect((await req("GET", "/api/tours", { token: other.token })).json.tours).toEqual([]);
    // a tour's key cannot open a tour of its own, whatever it holds
    const withIssue = (await open(t, { agent: "agent.c", caps: [...SPEC.caps, "grant.issue"] })).json;
    expect((await req("POST", "/api/tours", { token: withIssue.key.token, body: { ...SPEC, agent: "agent.d" } })).json.error).toBe("owner_required");
    // what it hands to a helper is an ordinary agent-issued key: a day at most, and gone at the next renewal
    const helper = await req("POST", "/api/grants", { token: withIssue.key.token, body: { sub: "agent:helper", caps: ["grant.read"], ttlSec: 7 * DAY, budget: { usd_cents: 0, calls: 5, deploys: 0 } } });
    expect(helper.status).toBe(201);
    expect(helper.json.exp).toBeLessThanOrEqual(now() + DAY);
  });

  // ---- review round 2: turns, races, and every failure path --------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reissue = (t, id) => req("POST", `/api/tours/${id}/reissue`, { token: t.token, body: {} });
  const genOf = async (id) => Number((await dbQuery("SELECT gen FROM tours WHERE id = $1", [id])).rows[0].gen);
  // a tour that froze because a replaced key was used again: its first key (replaced, the one that was reused) and its second (cancelled by the freeze)
  const frozenTour = async (t, over = {}) => {
    const first = (await open(t, over)).json;
    await rested(first.tour.id);
    const second = (await renew(first.key.token)).json;
    await longAgo(first.key.id);
    await works(first.key.token);
    return { id: first.tour.id, hold: first.receipt.holding_grant, first: first.key, second: second.key };
  };
  // A cancel MISSES one grant: the first `times` attempts to cancel it do nothing; the next one works.
  // (This is how a key "written at the very moment its parent was being cancelled" used to be shown. Since
  // 2026-10-09 the cancel finds such a key itself: revokeGrantTree goes at a key from its list and once more in its
  // second look, after it has taken the key above. So a key that gets past the CANCEL is one that gets past both
  // of those, and what is tested below is that the tour's own looks still find it then.)
  const missed = async (name, grantId, times, fn) => {
    await dbQuery("DELETE FROM settings WHERE key = $1", [name]);
    await dbQuery("INSERT INTO settings (key, value) VALUES ($1, $2)", [name, String(times)]);
    try {
      return await during(name, "grants", "BEFORE UPDATE", `OLD.id = '${grantId}' AND OLD.status = 'active' AND NEW.status = 'revoked'`,
        `IF (SELECT value::int FROM settings WHERE key = '${name}') > 0 THEN UPDATE settings SET value = (value::int - 1)::text WHERE key = '${name}'; RETURN NULL; END IF; RETURN NEW;`, fn);
    } finally {
      await dbQuery("DELETE FROM settings WHERE key = $1", [name]);
    }
  };
  const missedByTheCancel = (name, grantId, fn) => missed(name, grantId, 2, fn);

  test("turns: something that saw the tour one turn ago never touches the key of the turn after", async () => {
    const t = await newTenant("tour-turns", "studio");
    const f = await frozenTour(t);
    const fresh = await reissue(t, f.id);
    expect(fresh.status).toBe(201);
    const g = await genOf(f.id);
    // The sweep read this tour while it was still frozen, one turn ago, and only now comes to cancel what is under it.
    // (Its old view of the row is made real here: frozen, at the turn before the reissue.)
    await dbQuery("UPDATE tours SET status = 'frozen', gen = $2 WHERE id = $1", [f.id, g - 1]);
    expect((await admin("POST", "/api/admin/grants/reap")).status).toBe(200);
    expect(await works(fresh.json.key.token)).toBe(200);
    // The alarm likewise: an old key that still carries a renewal's mark is tried again at that moment.
    await dbQuery("UPDATE grants SET revoke_reason = 'tour: renewed', revoked_at = now() - interval '10 minutes' WHERE id = $1", [f.first.id]);
    expect(await works(f.first.token)).toBe(401);
    expect(await works(fresh.json.key.token)).toBe(200);
    expect(await liveUnder(f.hold)).toBe(1);
    // With the row as it really is (active, at the reissue's own turn) the same old key IS the alarm, and the
    // current turn's key does stop: the rule is "up to the turn it saw", not "never".
    await dbQuery("UPDATE tours SET status = 'active', gen = $2 WHERE id = $1", [f.id, g]);
    expect(await works(f.first.token)).toBe(401);
    expect((await tourOf(t, f.id)).status).toBe("frozen");
    expect(await works(fresh.json.key.token)).toBe(401);
  });

  test("reissue: a turn taken by somebody else in the middle means nothing is issued, or what was issued is taken back", async () => {
    const t = await newTenant("tour-reissue-turn", "studio");
    const first = (await open(t)).json;
    const hold = first.receipt.holding_grant;
    await rested(first.tour.id);
    const second = (await renew(first.key.token)).json; // so that one replaced key exists for the reissue to clear
    // between the reissue reading the tour and taking its turn, another turn is taken: it must stop before issuing anything
    let before = (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [hold])).rows[0].n;
    let r = await during("tr_turn_before_claim", "grants", "AFTER UPDATE", `OLD.parent = '${hold}' AND NEW.revoke_reason LIKE 'tour: renewed (before%' AND OLD.revoke_reason = 'tour: renewed'`,
      `UPDATE tours SET gen = gen + 1 WHERE id = '${first.tour.id}'; RETURN NULL;`, () => reissue(t, first.tour.id));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("tour_changed");
    expect(r.text).not.toContain("cog1.");
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [hold])).rows[0].n).toBe(before); // no key was even written
    expect(await works(second.key.token)).toBe(200); // and the agent's key was not touched
    // after its key is written but before it is noted, another turn is taken: the key is taken back, not handed out
    r = await during("tr_turn_after_issue", "grants", "AFTER INSERT", `NEW.parent = '${hold}'`, `UPDATE tours SET gen = gen + 1 WHERE id = '${first.tour.id}'; RETURN NULL;`, () => reissue(t, first.tour.id));
    expect(r.status).toBe(409);
    expect(r.text).not.toContain("cog1.");
    expect(await liveUnder(hold)).toBe(0);
    // its key is cancelled at the very moment it is being noted (an end or a freeze landing there): no dead key is answered
    r = await during("tr_dead_at_note", "tours", "BEFORE UPDATE", `OLD.id = '${first.tour.id}' AND OLD.current_key IS NULL AND NEW.current_key IS NOT NULL`,
      // (cancelled the way a real cancel does it: the key stops, and what it held goes back to the holding grant)
      `UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'test: cancelled as it was noted' WHERE id = NEW.current_key;
       UPDATE grants SET reserved = '{"usd_cents":0,"calls":0,"deploys":0}'::jsonb WHERE id = '${hold}'; RETURN NEW;`, () => reissue(t, first.tour.id));
    expect(r.status).toBe(409);
    expect(r.text).not.toContain("cog1.");
    // and left alone, it simply works
    r = await reissue(t, first.tour.id);
    expect(r.status).toBe(201);
    expect(await works(r.json.key.token)).toBe(200);
    expect(r.json.key.budget.calls).toBe(100);
    expect(await liveUnder(hold)).toBe(1);
  });

  test("an old key tried at the very moment the owner reissues does not freeze the tour again", async () => {
    const t = await newTenant("tour-alarm-vs-reissue", "studio");
    const first = (await open(t)).json;
    const hold = first.receipt.holding_grant;
    await rested(first.tour.id);
    const second = (await renew(first.key.token)).json;
    await longAgo(first.key.id);
    // The alarm has read the tour (active) and is cancelling its key when the owner's reissue takes its turn: the
    // reissue first clears the old keys of the alarm, then makes the tour active at a new turn with no key noted.
    await during("tr_reissue_mid_alarm", "grants", "AFTER UPDATE", `OLD.id = '${second.key.id}' AND OLD.status = 'active' AND NEW.status = 'revoked'`,
      `UPDATE grants SET revoke_reason = 'tour: renewed (before an owner reissue)' WHERE parent = '${hold}' AND revoke_reason = 'tour: renewed';
       UPDATE tours SET gen = gen + 1, status = 'active', frozen_reason = NULL, current_key = NULL WHERE id = '${first.tour.id}'; RETURN NULL;`,
      async () => expect(await works(first.key.token)).toBe(401));
    // the owner's turn stands: the alarm looked again, found the tour at a new turn and the old key cleared, and did nothing more
    expect((await dbQuery("SELECT status FROM tours WHERE id = $1", [first.tour.id])).rows[0].status).toBe("active");
    expect((await req("GET", "/api/ledger", { token: t.token })).json.ledger.map((l) => l.kind)).not.toContain("tour-freeze");
    const fresh = await reissue(t, first.tour.id);
    expect(fresh.status).toBe(201);
    expect(await works(fresh.json.key.token)).toBe(200);
  });

  test("reissue at the same moment as the sweep, as an old key being tried, as another reissue, or as a renewal: a key that is answered works", async () => {
    // These four are races, run several times each with the timing moved a little every time.
    // 1. a frozen tour is reissued while the owner's list (which sweeps) and the reaper's sweep run
    for (let i = 0; i < 8; i++) {
      const t = await newTenant(`tour-race-sweep-${i}`, "studio");
      const f = await frozenTour(t);
      const [fresh] = await Promise.all([reissue(t, f.id), sleep(i % 5).then(() => req("GET", "/api/tours", { token: t.token })), sleep((i * 3) % 7).then(() => admin("POST", "/api/admin/grants/reap"))]);
      expect(fresh.status).toBe(201);
      expect(await works(fresh.json.key.token)).toBe(200);
    }
    // 2. ...while the old key that froze it is tried again and again
    for (let i = 0; i < 8; i++) {
      const t = await newTenant(`tour-race-hammer-${i}`, "studio");
      const f = await frozenTour(t);
      const [fresh] = await Promise.all([reissue(t, f.id), ...Array.from({ length: 8 }, (_, j) => sleep(j * (1 + (i % 3))).then(() => works(f.first.token)))]);
      expect(fresh.status).toBe(201);
      expect(await works(fresh.json.key.token)).toBe(200);
      expect((await tourOf(t, f.id)).status).toBe("active"); // and it did not freeze the tour a second time
      expect(await works(f.first.token)).toBe(401);
      expect((await tourOf(t, f.id)).status).toBe("active");
    }
    // 3. two reissues at once: every answer is honest, and exactly one key works at the end
    for (let i = 0; i < 6; i++) {
      const t = await newTenant(`tour-race-twice-${i}`, "studio");
      const first = (await open(t)).json;
      const both = await Promise.all([reissue(t, first.tour.id), sleep(i % 4).then(() => reissue(t, first.tour.id))]);
      expect(both.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(both.some((r) => r.status === 201)).toBe(true);
      const tour = await tourOf(t, first.tour.id);
      expect(tour.status).toBe("active");
      expect(tour.live_keys).toBe(1);
      const winner = both.filter((r) => r.status === 201).find((r) => r.json.key.id === tour.key.id);
      expect(winner).toBeTruthy(); // the key the tour points at is one that was answered
      expect(await works(winner.json.key.token)).toBe(200);
      expect(winner.json.key.budget.calls).toBe(100);
      for (const r of both.filter((x) => x.status === 409)) expect(r.text).not.toContain("cog1.");
    }
    // 4. the agent renews while the owner reissues
    for (let i = 0; i < 8; i++) {
      const t = await newTenant(`tour-race-renew-${i}`, "studio");
      const first = (await open(t)).json;
      await rested(first.tour.id);
      const [a, b] = await Promise.all([sleep(i % 4).then(() => renew(first.key.token)), sleep((i * 2) % 5).then(() => reissue(t, first.tour.id))]);
      expect([201, 401, 404, 409].includes(a.status) && [201, 409].includes(b.status)).toBe(true);
      expect([a, b].some((r) => r.status === 201)).toBe(true); // one of them always gets through
      const tour = await tourOf(t, first.tour.id);
      expect(tour.status).toBe("active"); // never frozen (nobody used a replaced key), and never left without a key
      expect(tour.live_keys).toBe(tour.key ? 1 : 0); // no key works that the tour does not point at
      expect(await works(first.key.token)).toBe(401); // the key they both started from is gone either way
      const winner = [a, b].find((r) => r.status === 201 && r.json.key.id === tour.key.id);
      expect(winner).toBeTruthy(); // the key the tour points at is one that was answered
      expect(await works(winner.json.key.token)).toBe(200);
      expect(winner.json.key.budget.calls).toBe(100); // the loser's key did not keep any of the budget
      for (const r of [a, b].filter((x) => x.status !== 201)) expect(r.text).not.toContain("cog1.");
      expect(tour.left.calls).toBe(100);
      // whatever happened, the owner can always put it right
      const again = await reissue(t, first.tour.id);
      expect(again.status).toBe(201);
      expect(await works(again.json.key.token)).toBe(200);
    }
  }, 60000);

  test("a helper's key that a cancel missed is found at the next look, at any depth: on renewal, on a freeze, on the end", async () => {
    const t = await newTenant("tour-deep", "studio");
    const withHelpers = { caps: [...SPEC.caps, "grant.issue"] };
    const hire = (token) => req("POST", "/api/grants", { token, body: { sub: "agent:helper", caps: ["grant.read"], ttlSec: 600, budget: { usd_cents: 0, calls: 5, deploys: 0 } } });
    // renewal: the old key's helper is missed by the cancel and is left, not cancelled, under a cancelled key
    const first = (await open(t, { ...withHelpers, agent: "deep.a" })).json;
    let helper = (await hire(first.key.token)).json;
    await rested(first.tour.id);
    const second = (await missedByTheCancel("tr_miss_renew", helper.id, () => renew(first.key.token))).json;
    expect(await works(first.key.token)).toBe(401);
    // the look before the next key is issued goes under every key the tour ever had, not only the ones still working.
    // (Its STATUS is what shows that: a key under a cancelled key answers 401 whether it was found or not.)
    expect(await statusOf(helper.id)).toBe("revoked");
    expect(await works(helper.token)).toBe(401);
    expect(await works(second.key.token)).toBe(200);
    await rested(first.tour.id);
    const third = await renew(second.key.token);
    expect(third.status).toBe(201);
    // a freeze: the helper of the CURRENT key is missed by the alarm's first cancel
    helper = (await hire(third.json.key.token)).json;
    await longAgo(second.key.id);
    await missedByTheCancel("tr_miss_freeze", helper.id, async () => expect(await works(second.key.token)).toBe(401));
    expect((await tourOf(t, first.tour.id)).status).toBe("frozen");
    expect(await works(third.json.key.token)).toBe(401);
    expect(await statusOf(helper.id)).toBe("revoked");
    expect(await works(helper.token)).toBe(401);
    // the end: missed by the cancel AND by the first look after it, found by the look after that (it looks until a look finds nothing)
    const b = (await open(t, { ...withHelpers, agent: "deep.b" })).json;
    helper = (await hire(b.key.token)).json;
    const end = await missed("tr_miss_end", helper.id, 3, () => req("POST", `/api/tours/${b.tour.id}/end`, { token: t.token, body: {} }));
    expect(end.status).toBe(200);
    expect(await statusOf(helper.id)).toBe("revoked");
    expect(await works(helper.token)).toBe(401);
    expect(end.json.tour.status).toBe("ended");
    // and if it truly cannot be cancelled, the tour does NOT claim to be ended; the sweep finishes it when it can
    const c = (await open(t, { ...withHelpers, agent: "deep.c" })).json;
    helper = (await hire(c.key.token)).json;
    const stuck = await during("tr_never_cancel", "grants", "BEFORE UPDATE", `OLD.id = '${helper.id}' AND NEW.status = 'revoked'`, "RETURN NULL;", async () => {
      const r = await req("POST", `/api/tours/${c.tour.id}/end`, { token: t.token, body: {} });
      // it could not be cancelled, so it is still there; it no longer WORKS, because the key above it has ended
      // (grants.js, endedAbove; before 2026-10-09 it answered 200 here)
      expect(await statusOf(helper.id)).toBe("active");
      expect(await works(helper.token)).toBe(401);
      expect((await dbQuery("SELECT status FROM tours WHERE id = $1", [c.tour.id])).rows[0].status).not.toBe("ended");
      return r;
    });
    expect(stuck.status).toBe(500);
    expect((await admin("POST", "/api/admin/grants/reap")).json.tours_ended).toContain(c.tour.id);
    expect(await statusOf(helper.id)).toBe("revoked");
    expect((await tourOf(t, c.tour.id)).status).toBe("ended");
  }, 60000);

  test("a renewal that cannot issue the next key, or cannot record it, leaves no key working and says so; the old key is then just a dead key", async () => {
    const t = await newTenant("tour-renew-paths", "studio");
    // 1. the next key cannot be issued: the tour is frozen with that reason, and only the owner can put it right
    const a = (await open(t, { agent: "paths.a" })).json;
    await rested(a.tour.id);
    let r = await during("tr_no_next_key", "grants", "BEFORE INSERT", `NEW.parent = '${a.receipt.holding_grant}'`, "RAISE EXCEPTION 'test: no key can be written';", () => renew(a.key.token));
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("cog1.");
    expect(await works(a.key.token)).toBe(401);
    expect(await liveUnder(a.receipt.holding_grant)).toBe(0);
    let tour = await tourOf(t, a.tour.id);
    expect(tour.status).toBe("frozen");
    expect(tour.frozen_reason).toContain("could not issue");
    expect((await req("GET", "/api/ledger", { token: t.token })).json.ledger.some((l) => l.kind === "tour-freeze" && l.note.includes("renewal failed"))).toBe(true);
    const fresh = await reissue(t, a.tour.id);
    expect(fresh.status).toBe(201);
    expect(fresh.json.key.budget.calls).toBe(100);
    // 2. the key is issued but the tour's record cannot be written: the key is taken back, never handed out
    const b = (await open(t, { agent: "paths.b" })).json;
    await rested(b.tour.id);
    r = await during("tr_no_record", "tours", "BEFORE UPDATE", `OLD.id = '${b.tour.id}' AND NEW.renewals > OLD.renewals`, "RAISE EXCEPTION 'test: the renewal cannot be recorded';", () => renew(b.key.token));
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("cog1.");
    expect(await liveUnder(b.receipt.holding_grant)).toBe(0);
    tour = await tourOf(t, b.tour.id);
    expect(tour.status).toBe("key_run_out");
    expect(tour.renewals).toBe(0);
    expect((await reissue(t, b.tour.id)).status).toBe(201);
    // 3. the renewal loses its turn after cancelling its old key (as when the owner reissues at that moment): it answers
    //    409 with no key, and its old key, tried again later, is NOT the alarm: nobody was handed a next key by it.
    const c = (await open(t, { agent: "paths.c" })).json;
    await rested(c.tour.id);
    r = await during("tr_lost_turn", "grants", "AFTER INSERT", `NEW.parent = '${c.receipt.holding_grant}'`, `UPDATE tours SET gen = gen + 1, current_key = NULL WHERE id = '${c.tour.id}'; RETURN NULL;`, () => renew(c.key.token));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("tour_changed");
    expect(r.text).not.toContain("cog1.");
    expect(await liveUnder(c.receipt.holding_grant)).toBe(0);
    await longAgo(c.key.id);
    expect(await works(c.key.token)).toBe(401);
    expect((await tourOf(t, c.tour.id)).status).toBe("key_run_out"); // not frozen
    // 4. ...or loses it sooner: the owner's reissue takes its turn just as the renewal cancels its old key. The
    //    renewal stops there: it issues nothing at all, and again its old key is no alarm.
    const d = (await open(t, { agent: "paths.d" })).json;
    await rested(d.tour.id);
    const keysBefore = (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [d.receipt.holding_grant])).rows[0].n;
    r = await during("tr_reissue_at_cancel", "grants", "AFTER UPDATE", `OLD.id = '${d.key.id}' AND OLD.status = 'active' AND NEW.status = 'revoked'`,
      `UPDATE tours SET gen = gen + 1, current_key = NULL WHERE id = '${d.tour.id}'; RETURN NULL;`, () => renew(d.key.token));
    expect(r.status).toBe(409);
    expect(r.text).not.toContain("cog1.");
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [d.receipt.holding_grant])).rows[0].n).toBe(keysBefore); // no key was even written
    await longAgo(d.key.id);
    expect(await works(d.key.token)).toBe(401);
    expect((await tourOf(t, d.tour.id)).status).toBe("key_run_out");
    // 5. The owner cancels the agent's key in the instant after the renewal was let in (here: as its use is counted,
    //    the last thing done before a request is let in). The kill stands: no next key.
    const e = (await open(t, { agent: "paths.e" })).json;
    await rested(e.tour.id);
    r = await during("tr_killed_at_the_door", "rate_limits", "AFTER INSERT OR UPDATE", `NEW.grant_id = '${e.key.id}'`,
      `UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'test: cancelled by the owner at that moment' WHERE id = '${e.key.id}' AND status = 'active';
       UPDATE grants SET reserved = '{"usd_cents":0,"calls":0,"deploys":0}'::jsonb WHERE id = '${e.receipt.holding_grant}'; RETURN NULL;`, () => renew(e.key.token));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("tour_key_cancelled");
    expect(r.text).not.toContain("cog1.");
    expect(await liveUnder(e.receipt.holding_grant)).toBe(0);
    expect((await tourOf(t, e.tour.id)).status).toBe("key_run_out");
    expect((await req("GET", "/api/ledger", { token: t.token })).json.ledger.filter((l) => l.kind === "tour-freeze").length).toBe(1); // only the one from part 1
  });

  test("opening a tour whose first key cannot be issued leaves nothing behind, and an extension that cannot be recorded moves nothing", async () => {
    const t = await newTenant("tour-open-paths", "studio");
    const before = await reservedOf(t.grantId);
    const r = await during("tr_no_first_key", "grants", "BEFORE INSERT", `NEW.tenant = '${t.id}' AND NEW.sub = 'agent:first.fail'`, "RAISE EXCEPTION 'test: no first key';", () => open(t, { agent: "first.fail" }));
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("cog1.");
    expect(await reservedOf(t.grantId)).toEqual(before); // nothing is held
    const left = (await req("GET", "/api/tours", { token: t.token })).json.tours;
    expect(left.length).toBe(1);
    expect(left[0].status).toBe("ended");
    expect(left[0].ended_reason).toContain("first key");
    const again = await open(t, { agent: "first.fail" }); // the name is free
    expect(again.status).toBe(201);
    // extending: the holding grant's end and the tour's record move together or not at all
    const hold = again.json.receipt.holding_grant;
    const expOf = async () => Number((await dbQuery("SELECT exp FROM grants WHERE id = $1", [hold])).rows[0].exp);
    const was = await expOf();
    const x = await during("tr_no_extend_record", "tours", "BEFORE UPDATE", `OLD.id = '${again.json.tour.id}' AND NEW.until <> OLD.until`, "RAISE EXCEPTION 'test: the extension cannot be recorded';",
      () => req("POST", `/api/tours/${again.json.tour.id}/extend`, { token: t.token, body: { days: 2 } }));
    expect(x.status).toBe(500);
    expect(await expOf()).toBe(was);
    expect((await tourOf(t, again.json.tour.id)).until).toBe(was);
    expect((await req("GET", "/api/ledger", { token: t.token })).json.ledger.some((l) => l.kind === "tour-extend")).toBe(false);
  });

  test("the sweep looks at a tour again before ending it, and a frozen tour is never ended for being idle", async () => {
    const t = await newTenant("tour-sweep-again", "studio");
    const a = (await open(t, { agent: "sweep.a" })).json;
    const b = (await open(t, { agent: "sweep.b" })).json;
    // both have gone 49 hours without a renewal, so both are on the sweep's list
    await dbQuery("UPDATE tours SET last_renewed_at = last_renewed_at - $2 WHERE tenant = $1", [t.id, 49 * 3600]);
    // ...but at the moment the sweep takes the first of them, the OTHER is renewed (its clock starts again)
    const swept = await during("tr_renewed_meanwhile", "tours", "AFTER UPDATE",
      `NEW.tenant = '${t.id}' AND NEW.gen = OLD.gen + 1 AND NEW.status = OLD.status AND NEW.last_renewed_at = OLD.last_renewed_at`,
      `UPDATE tours SET last_renewed_at = extract(epoch from now())::bigint WHERE tenant = '${t.id}' AND id <> NEW.id AND status = 'active'; RETURN NULL;`,
      () => admin("POST", "/api/admin/grants/reap"));
    const ended = swept.json.tours_ended.filter((id) => id === a.tour.id || id === b.tour.id);
    expect(ended.length).toBe(1); // the one it took; the other was no longer idle when its turn came
    const [kept, gone] = ended[0] === a.tour.id ? [b, a] : [a, b];
    expect((await tourOf(t, kept.tour.id)).status).toBe("active");
    expect(await works(kept.key.token)).toBe(200);
    expect((await tourOf(t, gone.tour.id)).status).toBe("ended");
    // a frozen tour waits for the owner, however long nobody renews it
    const u = await newTenant("tour-frozen-idle", "studio");
    const f = await frozenTour(u);
    await dbQuery("UPDATE tours SET last_renewed_at = last_renewed_at - $2 WHERE id = $1", [f.id, 72 * 3600]);
    expect((await admin("POST", "/api/admin/grants/reap")).json.tours_ended).not.toContain(f.id);
    expect((await tourOf(u, f.id)).status).toBe("frozen");
    expect((await reissue(u, f.id)).status).toBe(201);
  });

  test("any mix of renewals, reissues, old-key reuse, lists and sweeps at the same moment leaves the tour in one piece", async () => {
    // A random mix each time (set TOURS_STRESS_RUNS for more). What must hold afterwards is checked in the tables.
    const RUNS = Number(process.env.TOURS_STRESS_RUNS || 40), rnd = (n) => Math.floor(Math.random() * n), bad = [];
    for (let i = 0; i < RUNS; i++) {
      const t = await newTenant(`tour-stress-${i}`, "studio");
      const first = (await open(t)).json, id = first.tour.id, hold = first.receipt.holding_grant;
      await rested(id);
      const second = (await renew(first.key.token)).json;
      await longAgo(first.key.id);
      const frozen = i % 3 === 0;
      if (frozen) await works(first.key.token); // the alarm: start this run from a frozen tour
      await rested(id);
      const again = () => reissue(t, id), next = () => renew(second.key.token), reuse = () => works(first.key.token);
      const look = () => req("GET", "/api/tours", { token: t.token }), sweep = () => admin("POST", "/api/admin/grants/reap");
      const menu = frozen ? [again, again, reuse, reuse, look, sweep] : [again, next, next, reuse, look, sweep, again];
      const picks = Array.from({ length: 2 + rnd(4) }, () => menu[rnd(menu.length)]);
      const answers = await Promise.all(picks.map((fn) => sleep(rnd(6)).then(fn)));
      const row = (await dbQuery("SELECT status, current_key FROM tours WHERE id = $1", [id])).rows[0];
      const live = (await dbQuery("SELECT id, budget->>'calls' AS calls FROM grants WHERE parent = $1 AND status = 'active'", [hold])).rows;
      const held = Number((await dbQuery("SELECT reserved->>'calls' AS calls FROM grants WHERE id = $1", [hold])).rows[0].calls);
      const say = (what) => bad.push(`run ${i} (${frozen ? "frozen" : "active"}: ${picks.map((p) => p.name).join(", ")}): ${what}`);
      if (live.length > 1) say("more than one key works");
      if (row.status === "frozen" && live.length) say("it reads frozen while a key works");
      if (live.length === 1 && row.current_key !== live[0].id) say("a key works that the tour does not point at");
      if (live.length === 1 && live[0].calls !== "100") say("the working key was not given everything the tour has left");
      if (held !== (live.length ? Number(live[0].calls) : 0)) say("the holding grant holds something no working key accounts for");
      const handed = answers.filter((a) => a && a.status === 201 && a.json && a.json.key);
      for (const a of handed) if (a.json.key.id === row.current_key && (await works(a.json.key.token)) !== 200) say("the key the tour points at was answered but does not work");
      if (row.status === "active" && row.current_key && row.current_key !== second.key.id && !handed.some((a) => a.json.key.id === row.current_key)) say("the tour points at a key nobody was handed");
      if (!frozen && row.status === "frozen" && !picks.includes(reuse)) say("it froze though nobody used a replaced key");
      if (!frozen && picks.every((p) => p === next) && (handed.length !== 1 || live.length !== 1)) say("only renewals ran, and not exactly one of them got its key");
      const fix = await again(); // and the owner can always put it right
      if (fix.status !== 201 || (await works(fix.json.key.token)) !== 200 || fix.json.key.budget.calls !== 100) say(`a reissue afterwards answered ${fix.status} ${fix.json?.error || ""}`);
    }
    expect(bad).toEqual([]);
  }, 120000);
});

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
    // (the parent is read from the table: the admin list shows only the newest 200 grants, and the pool is older than that by now)
    const parent = (await dbQuery("SELECT depth, tenant FROM grants WHERE id = $1", [ga.parent])).rows[0];
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
    // read from the table, not from the admin list: that list shows only the newest 200 grants
    const pool = (await dbQuery("SELECT id, budget, reserved FROM grants WHERE tenant = 'guest-pool' AND depth = 0")).rows[0];
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
    // read from the table, not from the admin list: that list shows only the newest 200 grants
    const pool = (await dbQuery("SELECT id, budget, reserved FROM grants WHERE tenant = 'guest-pool' AND depth = 0")).rows[0];
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

// What a key's helper spends counts against every grant above it, all the way up to the owner. Before
// 2026-10-09 it counted one level up only: when the grant in between ended, the grant above got its
// whole budget back and the spend was forgotten.
describe("18b. spend counts all the way up the chain", () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const left = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining.calls;
  const issue = (token, sub, calls, caps = ["grant.issue", "grant.read"]) => req("POST", "/api/grants", { token, body: { sub, caps, ttlSec: 3600, budget: { usd_cents: 0, calls, deploys: 0 } } });
  const spend = (token, calls) => req("POST", "/api/grants/settle", { token, body: { calls, ref: "work:test" } });

  test("a helper's helper spends 4: when the grant between them is cancelled, the owner still has 4 less", async () => {
    const root = await newTenant("chain-revoke", "pro");
    const before = await left(root.token);
    const mid = await issue(root.token, "agent:mid", 10);
    const leaf = await issue(mid.json.token, "agent:leaf", 6, ["grant.read"]);
    expect(leaf.status).toBe(201);
    expect((await spend(leaf.json.token, 4)).status).toBe(200);
    expect(await left(root.token)).toBe(before - 10); // while they live, the whole 10 is held
    expect((await req("POST", `/api/grants/${mid.json.id}/revoke`, { token: root.token, body: { reason: "test" } })).status).toBe(200);
    expect(await left(root.token)).toBe(before - 4); // the 6 nobody used came back; the 4 that were used did not
    // and it can be handed out again only up to what is really left
    expect((await issue(root.token, "agent:again", before - 4)).status).toBe(201);
    expect((await issue(root.token, "agent:over", 1)).status).toBeGreaterThanOrEqual(400);
  });

  test("the same when they simply run out (the sweep), in either order, and never twice", async () => {
    const root = await newTenant("chain-expire", "pro");
    const before = await left(root.token);
    const mid = await issue(root.token, "agent:mid", 10);
    const leaf = await issue(mid.json.token, "agent:leaf", 6, ["grant.read"]);
    expect((await spend(leaf.json.token, 4)).status).toBe(200);
    expect((await spend(mid.json.token, 1)).status).toBe(200); // the middle one uses 1 itself
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = ANY($2)", [past, [mid.json.id, leaf.json.id]]);
    expect((await admin("POST", "/api/admin/grants/reap")).status).toBe(200);
    expect(await left(root.token)).toBe(before - 5); // 4 by the helper's helper, 1 by the helper
    await admin("POST", "/api/admin/grants/reap");
    await req("POST", `/api/grants/${mid.json.id}/revoke`, { token: root.token, body: { reason: "again" } });
    expect(await left(root.token)).toBe(before - 5); // a second sweep and a late cancel change nothing
    // A grant WAITS for the keys under it: while one of them is still live, what is held on it is not yet "what
    // they used", so the sweep leaves it alone rather than guess. (Only a test can put a parent's end before its
    // child's; a real child never outlives its parent.)
    const mid2 = await issue(root.token, "agent:mid2", 10);
    const leaf2 = await issue(mid2.json.token, "agent:leaf2", 6, ["grant.read"]);
    expect((await spend(leaf2.json.token, 2)).status).toBe(200);
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, mid2.json.id]);
    expect((await admin("POST", "/api/admin/grants/reap")).json.reaped).not.toContain(mid2.json.id);
    expect(await left(root.token)).toBe(before - 5 - 10); // still holding all 10: nothing was let go early
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, leaf2.json.id]);
    const swept = (await admin("POST", "/api/admin/grants/reap")).json.reaped;
    expect(swept).toContain(leaf2.json.id);
    expect(swept).toContain(mid2.json.id); // one pass, the lower one first
    expect(await left(root.token)).toBe(before - 5 - 2);
    await admin("POST", "/api/admin/grants/reap");
    expect(await left(root.token)).toBe(before - 5 - 2);
  });

  test("whatever order things end in, the owner is left holding exactly what was used", async () => {
    const root = await newTenant("chain-orders", "pro");
    const before = await left(root.token);
    // 1. the lower key is cancelled first, then the one above it runs out
    let mid = await issue(root.token, "agent:m1", 10), leaf = await issue(mid.json.token, "agent:l1", 6, ["grant.read"]);
    expect((await spend(leaf.json.token, 3)).status).toBe(200);
    expect((await req("POST", `/api/grants/${leaf.json.id}/revoke`, { token: mid.json.token, body: {} })).status).toBe(200);
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, mid.json.id]);
    expect((await admin("POST", "/api/admin/grants/reap")).json.reaped).toContain(mid.json.id);
    expect(await left(root.token)).toBe(before - 3);
    // 2. the lower key has run out but the sweep has not reached it yet, and the one above is cancelled
    mid = await issue(root.token, "agent:m2", 10); leaf = await issue(mid.json.token, "agent:l2", 6, ["grant.read"]);
    expect((await spend(leaf.json.token, 2)).status).toBe(200);
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, leaf.json.id]);
    expect((await req("POST", `/api/grants/${mid.json.id}/revoke`, { token: root.token, body: {} })).status).toBe(200);
    expect(await left(root.token)).toBe(before - 3 - 2);
    // 3. the sweep took the lower key earlier; cancelling the one above later must not let it go a second time
    mid = await issue(root.token, "agent:m3", 10); leaf = await issue(mid.json.token, "agent:l3", 6, ["grant.read"]);
    expect((await spend(leaf.json.token, 1)).status).toBe(200);
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [past, leaf.json.id]);
    expect((await admin("POST", "/api/admin/grants/reap")).json.reaped).toContain(leaf.json.id);
    expect((await req("POST", `/api/grants/${mid.json.id}/revoke`, { token: root.token, body: {} })).json.revoked).toEqual([mid.json.id]);
    expect(await left(root.token)).toBe(before - 3 - 2 - 1);
    // 4. cancelling something that has already ended gives nothing back and takes nothing
    expect((await req("POST", `/api/grants/${mid.json.id}/revoke`, { token: root.token, body: {} })).json.revoked).toEqual([]);
    await admin("POST", "/api/admin/grants/reap");
    expect(await left(root.token)).toBe(before - 6);
  });

  test("three levels down, and one level down still works as it always did", async () => {
    const root = await newTenant("chain-deep", "studio");
    const before = await left(root.token);
    const a = await issue(root.token, "agent:a", 20);
    const b = await issue(a.json.token, "agent:b", 12);
    const c = await issue(b.json.token, "agent:c", 8, ["grant.read"]);
    expect(c.status).toBe(201);
    expect((await spend(c.json.token, 3)).status).toBe(200);
    expect((await spend(b.json.token, 2)).status).toBe(200);
    // cancel the lowest first, then the top: the answer must not depend on the order things end in
    expect((await req("POST", `/api/grants/${c.json.id}/revoke`, { token: b.json.token, body: {} })).status).toBe(200);
    expect(await left(b.json.token)).toBe(12 - 2 - 3);
    expect((await req("POST", `/api/grants/${a.json.id}/revoke`, { token: root.token, body: {} })).status).toBe(200);
    expect(await left(root.token)).toBe(before - 5);
    const direct = await issue(root.token, "agent:direct", 10, ["grant.read"]);
    expect((await spend(direct.json.token, 7)).status).toBe(200);
    expect((await req("POST", `/api/grants/${direct.json.id}/revoke`, { token: root.token, body: {} })).status).toBe(200);
    expect(await left(root.token)).toBe(before - 5 - 7);
  });
});

// Two older faults in cancelling, both closed on 2026-10-09 (src/grants.js, revokeGrantTree).
//
// 1. A key issued under a grant AT THE MOMENT that grant was being cancelled was missed: it stayed live under a
//    cancelled parent, and its whole budget stayed held on the grant above for good.
// 2. A cancel that lost a lock wait (Postgres aborts one of two transactions that each hold what the other wants)
//    simply failed, and a sweep pass that lost one skipped every candidate after it.
//
// WHAT THESE TESTS CAN AND CANNOT SHOW. The suite's database is ONE connection, so two transactions never really
// run side by side here. Instead a database trigger makes the other party's work appear at one chosen statement,
// which is where the other transaction would have finished, or makes that statement fail with the very error
// Postgres gives the side it aborts (SQLSTATE 40P01). So these tests pin what the code DOES once it meets that
// state or that error. That the state and the error arise the way the notes in grants.js say, and that no other
// interleaving exists, rests on reading the lock sequences, not on a test.
describe("18c. a cancel leaves nothing working under it, and losing a lock wait does not fail it", () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const works = async (token) => (await req("GET", "/api/grants/verify", { token })).status;
  const left = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining.calls;
  const issue = (token, sub, calls, caps = ["grant.issue", "grant.read"]) => req("POST", "/api/grants", { token, body: { sub, caps, ttlSec: 3600, budget: { usd_cents: 0, calls, deploys: 0 } } });
  const spend = (token, calls) => req("POST", "/api/grants/settle", { token, body: { calls, ref: "work:test" } });
  const cancel = (token, id) => req("POST", `/api/grants/${id}/revoke`, { token, body: { reason: "test" } });
  const statusOf = async (id) => (await dbQuery("SELECT status FROM grants WHERE id = $1", [id])).rows[0]?.status;
  const rowOf = async (id) => JSON.parse(JSON.stringify((await dbQuery("SELECT status, reserved, settled FROM grants WHERE id = $1", [id])).rows[0]));
  // what each grant gave back to the one above it, one number per time it let go (never more than one)
  const gaveBack = async (id) => (await dbQuery("SELECT calls FROM ledger WHERE kind = 'release' AND grant_id = $1 ORDER BY id", [id])).rows.map((r) => r.calls);
  // Something happens at ONE chosen statement, for the length of `fn`: a trigger that exists only inside one test.
  const at = async (name, table, timing, when, body, fn) => {
    await dbQuery(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN ${body} END $f$`);
    await dbQuery(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
    try {
      return await fn();
    } finally {
      await dbQuery(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await dbQuery(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  };
  const beingCancelled = (id) => `OLD.id = '${id}' AND OLD.status = 'active' AND NEW.status = 'revoked'`;
  // Keys that were "issued while the grant above them was being cancelled". They are issued for real first, so
  // their tokens are real, then taken out from under their parent again (nothing held for them there), so the
  // cancel's list cannot see them: as if they had not been issued yet. They are put back, in the order given, at
  // the very statement that takes the parent, with their budget held on the parent, which is exactly what
  // issueChildGrant leaves when it finishes just before.
  const issuedDuringCancel = async (name, parentId, childIds, held, fn) => {
    await dbQuery("UPDATE grants SET parent = NULL WHERE id = ANY($1)", [childIds]);
    await dbQuery(`UPDATE grants SET reserved = '{"usd_cents":0,"calls":0,"deploys":0}'::jsonb WHERE id = $1`, [parentId]);
    return at(name, "grants", "BEFORE UPDATE", beingCancelled(parentId),
      `${childIds.map((id) => `UPDATE grants SET parent = '${parentId}' WHERE id = '${id}';`).join(" ")} NEW.reserved := '{"usd_cents":0,"calls":${held},"deploys":0}'::jsonb; RETURN NEW;`, fn);
  };
  // The statement that takes `id` fails the first `times` times with the error Postgres gives the side it aborts
  // in a lock cycle. The count is a sequence because a sequence is not undone when the transaction is.
  const losesTheWait = async (name, id, to, times, fn, error = "RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';") => {
    await dbQuery(`DROP SEQUENCE IF EXISTS ${name}_n`);
    await dbQuery(`CREATE SEQUENCE ${name}_n`);
    try {
      const r = await at(name, "grants", "BEFORE UPDATE", `OLD.id = '${id}' AND OLD.status = 'active' AND NEW.status = '${to}'`, `IF nextval('${name}_n') <= ${times} THEN ${error} END IF; RETURN NEW;`, fn);
      const n = (await dbQuery(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM ${name}_n`)).rows[0].n;
      return { r, tries: Number(n) };
    } finally {
      await dbQuery(`DROP SEQUENCE IF EXISTS ${name}_n`);
    }
  };

  test("a helper issued while the key above it is being cancelled is cancelled with it, and the owner gets back all that nobody used", async () => {
    const root = await newTenant("cancel-race", "studio");
    const before = await left(root.token);
    // 1. the sequence as it was found: one key is cancelled, and a helper is issued under it at that moment
    let mid = await issue(root.token, "agent:mid", 10),
      late = await issue(mid.json.token, "agent:late", 6, ["grant.read"]);
    expect(late.status).toBe(201);
    expect((await spend(late.json.token, 2)).status).toBe(200);
    let r = await issuedDuringCancel("t18c_late_one", mid.json.id, [late.json.id], 6, () => cancel(root.token, mid.json.id));
    expect(r.status).toBe(200);
    expect(r.json.revoked).toEqual([late.json.id, mid.json.id]); // the lower one first
    expect(await statusOf(late.json.id)).toBe("revoked");
    expect(await works(late.json.token)).toBe(401);
    expect(await gaveBack(late.json.id)).toEqual([4]); // 6 less the 2 it used
    expect(await gaveBack(mid.json.id)).toEqual([8]); // 10 less the 2 used under it: read AFTER the helper let go
    expect(await left(root.token)).toBe(before - 2);
    // 2. the same from higher up, and the helper has a helper of its own: the whole of what was issued late goes
    const top = await issue(root.token, "agent:top", 20);
    mid = await issue(top.json.token, "agent:mid", 10);
    late = await issue(mid.json.token, "agent:late", 6);
    const under = await issue(late.json.token, "agent:under", 3, ["grant.read"]);
    expect(under.status).toBe(201);
    expect((await spend(late.json.token, 2)).status).toBe(200);
    expect((await spend(under.json.token, 1)).status).toBe(200);
    r = await issuedDuringCancel("t18c_late_tree", mid.json.id, [late.json.id], 6, () => cancel(root.token, top.json.id));
    expect(r.status).toBe(200);
    expect(r.json.revoked).toEqual([under.json.id, late.json.id, mid.json.id, top.json.id]);
    for (const g of [under, late, mid, top]) expect(await statusOf(g.json.id)).toBe("revoked");
    expect(await works(late.json.token)).toBe(401);
    expect(await works(under.json.token)).toBe(401);
    expect(await gaveBack(under.json.id)).toEqual([2]); // 3 less the 1 it used
    expect(await gaveBack(late.json.id)).toEqual([3]); // 6 less its own 2, less the 1 used under it
    expect(await gaveBack(mid.json.id)).toEqual([7]); // 10 less the 3 used under it
    expect(await gaveBack(top.json.id)).toEqual([17]); // 20 less those 3
    // The owner is left holding exactly what was used (2, then 2 + 1), and can hand out the rest and no more.
    expect(await left(root.token)).toBe(before - 5);
    expect((await issue(root.token, "agent:again", before - 5)).status).toBe(201);
    expect((await issue(root.token, "agent:over", 1)).status).toBeGreaterThanOrEqual(400);
  });

  test("a key issued under a grant that somebody else ended while the cancel ran is cancelled too", async () => {
    // A cancel skips a grant it finds already ended. The sweep and another cancel leave nothing active under a
    // grant they end, but a capture does not look under the hold it ends. So the cancel looks under such a grant
    // as well. Here: `mid` is in the cancel's list; before the cancel reaches it (at the statement that takes the
    // key under it, which comes first) it is ended as a capture would end it, and a key has been issued under it.
    const root = await newTenant("cancel-race-ended", "studio");
    const before = await left(root.token);
    const mid = await issue(root.token, "agent:mid", 10);
    const first = await issue(mid.json.token, "agent:first", 2, ["grant.read"]);
    const late = await issue(mid.json.token, "agent:late", 3, ["grant.read"]);
    expect(late.status).toBe(201);
    await dbQuery("UPDATE grants SET parent = NULL WHERE id = $1", [late.json.id]);
    await dbQuery(`UPDATE grants SET reserved = '{"usd_cents":0,"calls":2,"deploys":0}'::jsonb WHERE id = $1`, [mid.json.id]);
    const r = await at("t18c_ended_meanwhile", "grants", "BEFORE UPDATE", beingCancelled(first.json.id),
      `UPDATE grants SET status = 'captured', reserved = '{"usd_cents":0,"calls":5,"deploys":0}'::jsonb WHERE id = '${mid.json.id}'; UPDATE grants SET parent = '${mid.json.id}' WHERE id = '${late.json.id}'; RETURN NEW;`,
      () => cancel(root.token, mid.json.id));
    expect(r.status).toBe(200);
    expect(r.json.revoked).toEqual([first.json.id, late.json.id]); // not `mid`: this cancel did not end it
    expect(await statusOf(mid.json.id)).toBe("captured");
    expect(await statusOf(late.json.id)).toBe("revoked");
    expect(await works(late.json.token)).toBe(401);
    expect(await gaveBack(late.json.id)).toEqual([3]);
    expect(await gaveBack(mid.json.id)).toEqual([]); // and it let go of nothing for a grant it did not end
    expect((await rowOf(mid.json.id)).reserved.calls).toBe(0); // both keys under it gave back all they held
    expect(await left(root.token)).toBe(before - 10); // what `mid` held is whoever ended it's to settle, not the cancel's
  });

  test("a key under a grant that has ended does not work: it is refused at the door, and cannot settle or issue even past the door", async () => {
    const root = await newTenant("cancel-orphan", "studio");
    const top = await issue(root.token, "agent:top", 30);
    const mid = await issue(top.json.token, "agent:mid", 20);
    const leaf = await issue(mid.json.token, "agent:leaf", 10);
    const deep = await issue(leaf.json.token, "agent:deep", 2, ["grant.read"]);
    expect(deep.status).toBe(201);
    const end = (id, status) => dbQuery("UPDATE grants SET status = $2 WHERE id = $1", [id, status]);
    // The state the old fault left behind, written by hand: a grant ended, the keys under it not. Whatever way it
    // ended, and whether it is the grant just above or one further up, every key under it is refused.
    for (const [which, status] of [[mid, "revoked"], [mid, "expired"], [mid, "captured"], [top, "revoked"]]) {
      expect(await works(leaf.json.token)).toBe(200); // control: with everything above it active, it works
      expect(await works(deep.json.token)).toBe(200);
      await end(which.json.id, status);
      const refused = await req("GET", "/api/grants/verify", { token: leaf.json.token });
      expect(refused.status).toBe(401);
      expect(refused.json.error).toBe("grant_revoked");
      expect(await works(deep.json.token)).toBe(401); // two below the one that ended
      expect((await spend(leaf.json.token, 1)).status).toBe(401);
      expect((await issue(leaf.json.token, "agent:no", 1)).status).toBe(401);
      expect(await works(which === mid ? top.json.token : root.token)).toBe(200); // the grant above the ended one is untouched
      await end(which.json.id, "active");
    }
    // PAST THE DOOR. The door (verifyGrant) reads once, when the request comes in. If the grant above ends after
    // that read, the write itself must still refuse. Made to happen here at the door's last statement (its
    // rate-limit count), which is after its read of the grant and before the write.
    const afterTheDoor = (name, which, status, fn) => at(name, "rate_limits", "BEFORE INSERT", `NEW.grant_id = '${leaf.json.id}'`, `UPDATE grants SET status = '${status}' WHERE id = '${which.json.id}'; RETURN NEW;`, fn);
    const was = await rowOf(leaf.json.id);
    // the grant just above, and the one above that; cancelled, run out, captured
    for (const [n, which, status] of [[1, mid, "revoked"], [2, top, "expired"], [3, top, "captured"]]) {
      const settle = await afterTheDoor(`t18c_ends_before_settle_${n}`, which, status, () => spend(leaf.json.token, 1));
      expect(settle.status).toBe(401);
      expect(settle.json.error).toBe("grant_not_active"); // the settle's own refusal, not the door's
      await end(which.json.id, "active");
      const hire = await afterTheDoor(`t18c_ends_before_issue_${n}`, which, status, () => issue(leaf.json.token, "agent:no", 1));
      expect(hire.status).toBe(403);
      expect(hire.json.error).toBe("parent_not_active"); // the issue's own refusal
      await end(which.json.id, "active");
    }
    expect(await rowOf(leaf.json.id)).toEqual(was); // nothing was settled on it and nothing is held on it for a new key
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [leaf.json.id])).rows[0].n).toBe(1);
    // with the grant above active again, both go through: it was only ever the ended grant that stopped them
    expect((await spend(leaf.json.token, 1)).status).toBe(200);
    expect((await issue(leaf.json.token, "agent:yes", 1, ["grant.read"])).status).toBe(201);
    // and a key under an ended grant can still be CANCELLED, through the ordinary route
    await end(mid.json.id, "revoked");
    expect((await cancel(root.token, leaf.json.id)).json.revoked).toContain(leaf.json.id);
    expect(await statusOf(deep.json.id)).toBe("revoked");
  });

  test("the owner's approval does not run a request filed by a key whose grant above has since ended", async () => {
    // An approval is run under the grant that asked, without coming through the door. So it looks above that grant
    // itself, before anything is done (a deploy is created first and charged after).
    const root = await newTenant("cancel-orphan-approval", "pro");
    const grant = (token, sub, caps, constraints) => req("POST", "/api/grants", { token, body: { sub, caps, ttlSec: 3600, budget: { usd_cents: 500, calls: 5, deploys: 0 }, ...(constraints ? { constraints } : {}) } });
    const mid = await grant(root.token, "agent:mid", ["grant.issue", "grant.read", "escrow.hold"]);
    const asker = await grant(mid.json.token, "agent:asker", ["escrow.hold", "grant.read"], { autonomy: "ask" });
    expect(asker.status).toBe(201);
    const ask = () => req("POST", "/api/escrow", { token: asker.json.token, body: { amount: 100, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" } } });
    const decide = (id) => req("POST", `/api/approvals/${id}`, { token: root.token, body: { decision: "approve" } });
    const filed = await ask();
    expect(filed.status).toBe(202);
    await dbQuery("UPDATE grants SET status = 'revoked' WHERE id = $1", [mid.json.id]);
    const refused = await decide(filed.json.approval.id);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("requesting_grant_not_active");
    const row = (await dbQuery("SELECT status, result FROM approvals WHERE id = $1", [filed.json.approval.id])).rows[0];
    expect(row.status).toBe("failed");
    expect((await rowOf(asker.json.id)).reserved.usd_cents).toBe(0); // nothing was held
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [asker.json.id])).rows[0].n).toBe(0);
    // control: with the grant above it active, the same request is approved and the hold opens
    await dbQuery("UPDATE grants SET status = 'active' WHERE id = $1", [mid.json.id]);
    const again = await ask();
    expect(again.status).toBe(202);
    expect((await decide(again.json.approval.id)).status).toBe(200);
    expect((await rowOf(asker.json.id)).reserved.usd_cents).toBe(100);
  });

  test("nobody hands out a fresh token for a key whose grant above has ended: not the admin, not the OAuth refresh", async () => {
    const root = await newTenant("cancel-orphan-tokens", "pro");
    const mid = await issue(root.token, "agent:mid", 10);
    const leaf = await issue(mid.json.token, "agent:leaf", 4, ["grant.read"]);
    const resign = (id) => admin("POST", `/api/admin/grants/${id}/token`);
    expect((await resign(leaf.json.id)).status).toBe(200); // control
    await dbQuery("UPDATE grants SET status = 'revoked' WHERE id = $1", [mid.json.id]);
    const no = await resign(leaf.json.id);
    expect(no.status).toBe(404);
    expect(no.json.error).toBe("grant_not_active");
    expect(no.text).not.toContain("cog1.");
    // OAuth. A refresh signs the SAME grant again while it has more than an hour left. If the grant above it has
    // ended, that token would answer 401 at the door for as long as the client kept refreshing; the client is told
    // to approve again instead.
    const redirect = "https://devdesk.meshtool.ai/runtime/callback";
    const client = (await req("POST", "/oauth/register", { body: { client_name: "orphan", redirect_uris: [redirect] } })).json.client_id;
    const verifier = "orphan-verifier-" + "z".repeat(40);
    const ap = await admin("POST", "/oauth/approve", { body: { client_id: client, redirect_uri: redirect, code_challenge: s256(verifier), state: "o", tenant: root.id } });
    const tok = await req("POST", "/oauth/token", { body: { grant_type: "authorization_code", code: new URL(ap.json.redirect).searchParams.get("code"), client_id: client, redirect_uri: redirect, code_verifier: verifier } });
    expect(tok.status).toBe(200);
    const refresh = (t) => req("POST", "/oauth/token", { body: { grant_type: "refresh_token", refresh_token: t, client_id: client } });
    const first = await refresh(tok.json.refresh_token);
    expect(first.status).toBe(200); // control: everything above it active, the same grant is signed again
    const me = await req("GET", "/api/grants/verify", { token: first.json.access_token });
    expect(me.status).toBe(200);
    // the grant above it ends (written by hand: a real cancel would take the OAuth grant with it)
    await dbQuery("UPDATE grants SET status = 'revoked' WHERE id = (SELECT parent FROM grants WHERE id = $1)", [me.json.id]);
    expect(await statusOf(me.json.id)).toBe("active");
    const second = await refresh(first.json.refresh_token);
    expect(second.status).toBe(400);
    expect(second.json.error).toBe("invalid_grant");
    expect(second.text).not.toContain("cog1.");
  });

  test("a cancel that loses a lock wait starts again and lets go exactly once; it gives up after three tries with nothing changed; any other failure is not tried again", async () => {
    const root = await newTenant("cancel-retry", "studio");
    const before = await left(root.token);
    const tree = async (n) => {
      const mid = await issue(root.token, `agent:mid${n}`, 10);
      const leaf = await issue(mid.json.token, `agent:leaf${n}`, 6, ["grant.read"]);
      expect((await spend(leaf.json.token, 2)).status).toBe(200);
      return { mid: mid.json.id, leaf: leaf.json.id };
    };
    // The failure comes when `mid` is taken, which is AFTER the leaf under it was cancelled and had let go in the
    // same transaction. So a try that fails must leave nothing of that behind, or the next try would let go twice.
    // 1. lost once, then twice: it finishes. A lost wait is known by its code (40P01) whatever its words are, and by
    //    its words if a driver does not pass the code on.
    const shapes = { 1: "RAISE EXCEPTION 'Verklemmung entdeckt' USING ERRCODE = '40P01';", 2: "RAISE EXCEPTION 'deadlock detected';" };
    for (const lost of [1, 2]) {
      const g = await tree(lost);
      const { r, tries } = await losesTheWait(`t18c_lost_${lost}`, g.mid, "revoked", lost, () => cancel(root.token, g.mid), shapes[lost]);
      expect(r.status).toBe(200);
      expect(tries).toBe(lost + 1);
      expect(r.json.revoked).toEqual([g.leaf, g.mid]); // the answer is the try that worked, not a list from each try
      expect(await gaveBack(g.leaf)).toEqual([4]);
      expect(await gaveBack(g.mid)).toEqual([8]);
      expect(await left(root.token)).toBe(before - 2 * lost);
    }
    // 2. lost every time: three tries, then the failure is the caller's to see, and NOTHING has changed
    const g = await tree(3);
    const stuck = await losesTheWait("t18c_lost_always", g.mid, "revoked", 1000, () => cancel(root.token, g.mid));
    expect(stuck.r.status).toBe(500);
    expect(stuck.tries).toBe(3);
    expect(await statusOf(g.leaf)).toBe("active");
    expect(await statusOf(g.mid)).toBe("active");
    expect(await gaveBack(g.leaf)).toEqual([]);
    expect(await left(root.token)).toBe(before - 4 - 10);
    // 3. a failure that is not a lost wait is not tried again
    const other = await losesTheWait("t18c_other_error", g.mid, "revoked", 1000, () => cancel(root.token, g.mid), "RAISE EXCEPTION 'test: this key cannot be cancelled right now';");
    expect(other.r.status).toBe(500);
    expect(other.tries).toBe(1);
    expect(await statusOf(g.leaf)).toBe("active");
    // and with nothing in the way it is cancelled as usual
    expect((await cancel(root.token, g.mid)).json.revoked).toEqual([g.leaf, g.mid]);
    expect(await left(root.token)).toBe(before - 6);
  });

  test("the sweep: one grant that cannot be released does not stop the pass, the pass says which one, and the next pass takes it", async () => {
    const a = await newTenant("sweep-a", "studio");
    const b = await newTenant("sweep-b", "studio");
    const before = await left(a.token);
    // a lost lock wait, and then any other failure: neither ends the pass, neither is hidden
    const kinds = [["deadlock detected", "RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';"], ["test: this grant cannot be released", "RAISE EXCEPTION 'test: this grant cannot be released';"]];
    for (const [n, [words, error]] of kinds.entries()) {
      const mid = await issue(a.token, `agent:mid${n}`, 10);
      const leaf = await issue(mid.json.token, `agent:leaf${n}`, 6, ["grant.read"]);
      const other = await issue(b.token, `agent:other${n}`, 5, ["grant.read"]);
      expect((await spend(leaf.json.token, 2)).status).toBe(200);
      await dbQuery("UPDATE grants SET exp = $1 WHERE id = ANY($2)", [past, [mid.json.id, leaf.json.id, other.json.id]]);
      // The leaf is the deepest, so the pass comes to it first. It fails, every time, for the length of this pass.
      const { r, tries } = await losesTheWait(`t18c_sweep_${n}`, leaf.json.id, "expired", 1000, () => admin("POST", "/api/admin/grants/reap"), error);
      expect(r.status).toBe(200); // the pass did not fail
      expect(tries).toBe(1); // the sweep does not try a candidate twice in one pass
      expect(r.json.reaped).toContain(other.json.id); // a candidate AFTER the one that failed was still released
      expect(r.json.reaped).not.toContain(leaf.json.id);
      expect(r.json.reaped).not.toContain(mid.json.id); // the grant above it waited for it
      expect(r.json.failed.map((f) => f.id)).toEqual([leaf.json.id]); // and the pass says what it left, and why
      expect(r.json.failed[0].error).toContain(words);
      expect(await statusOf(leaf.json.id)).toBe("active");
      expect(await statusOf(mid.json.id)).toBe("active");
      expect((await rowOf(b.grantId)).reserved.calls).toBe(0); // b got its 5 back in that same pass
      // the next pass takes both, the lower one first, and the owner is left holding exactly what was used
      const next = (await admin("POST", "/api/admin/grants/reap")).json;
      expect(next.failed).toEqual([]);
      expect(next.reaped).toContain(leaf.json.id);
      expect(next.reaped).toContain(mid.json.id);
      expect(await gaveBack(leaf.json.id)).toEqual([4]);
      expect(await gaveBack(mid.json.id)).toEqual([8]);
      expect(await left(a.token)).toBe(before - 2 * (n + 1));
    }
  });

  test("a cancel takes the grants in one fixed order: the lower ones first, and within one level by id; keys found by its second look by id too", async () => {
    // The order grants are TAKEN in is the order their rows are locked in, which is what decides whether two
    // transactions can end up waiting on each other. So it is written down here as it happens, by a trigger.
    const root = await newTenant("cancel-order", "studio");
    const under = async (parentId) => (await dbQuery("SELECT id FROM grants WHERE parent = $1 ORDER BY id", [parentId])).rows.map((x) => x.id);
    const takenDuring = async (name, fn) => {
      await dbQuery("CREATE TABLE IF NOT EXISTS t18c_taken (n BIGSERIAL PRIMARY KEY, id TEXT NOT NULL)");
      await dbQuery("DELETE FROM t18c_taken");
      const r = await at(name, "grants", "BEFORE UPDATE", `OLD.tenant = '${root.id}' AND OLD.status = 'active' AND NEW.status = 'revoked'`, "INSERT INTO t18c_taken (id) VALUES (OLD.id); RETURN NEW;", fn);
      return { r, taken: (await dbQuery("SELECT id FROM t18c_taken ORDER BY n")).rows.map((x) => x.id) };
    };
    // 1. the list. Ids are random, so a tree is built again until (a) the order its keys were made in is NOT their
    //    order by id, and (b) one of them sorts AFTER the grant they hang from. Then neither "whatever order the
    //    database lists them in" nor "by id alone" could pass by luck. About six tries in seven do at once; forty
    //    tries cannot all miss. (Which id sorts after which is asked of the database, whose order it is.)
    const sortsAfter = async (parentId) => (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1 AND id > $1", [parentId])).rows[0].n > 0;
    let mid, made;
    for (let tries = 0; tries < 40; tries++) {
      mid = await issue(root.token, `agent:mid${tries}`, 40);
      made = [];
      for (let n = 0; n < 6; n++) {
        const k = await issue(mid.json.token, `agent:k${n}`, 2);
        expect(k.status).toBe(201);
        made.push(k.json.id);
        if (n === 0) for (const m of [1, 2]) expect((await issue(k.json.token, `agent:kk${m}`, 1, ["grant.read"])).status).toBe(201); // and a level further down
      }
      if (String(made) !== String(await under(mid.json.id)) && (await sortsAfter(mid.json.id))) break;
    }
    expect(made).not.toEqual(await under(mid.json.id));
    expect(await sortsAfter(mid.json.id)).toBe(true);
    const expected = [...(await under(made[0])), ...(await under(mid.json.id)), mid.json.id];
    const one = await takenDuring("t18c_taken_list", () => cancel(root.token, mid.json.id));
    expect(one.r.status).toBe(200);
    expect(one.taken).toEqual(expected);
    expect(one.r.json.revoked).toEqual(expected);
    // 2. the second look. Three keys are issued while their parent is being cancelled, written in the OPPOSITE of
    //    their order by id; they are taken by id all the same.
    const top = await issue(root.token, "agent:top", 10);
    const late = [];
    for (const n of [1, 2, 3]) late.push((await issue(top.json.token, `agent:late${n}`, 1, ["grant.read"])).json.id);
    const byId = await under(top.json.id);
    const two = await takenDuring("t18c_taken_late", () => issuedDuringCancel("t18c_late_order", top.json.id, [...byId].reverse(), 3, () => cancel(root.token, top.json.id)));
    expect(two.r.status).toBe(200);
    expect(two.taken).toEqual([top.json.id, ...byId]); // the parent first (they were not there yet), then by id
    expect(two.r.json.revoked).toEqual([...byId, top.json.id]);
  });
});

describe("19. escrow keystone (stage 1: open + read)", () => {
  const remainingOf = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining;
  const openBody = (over = {}) => ({ amount: 500, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, ...over });

  test("open HOLDS value: the amount is reserved off the payer and the escrow reads back open", async () => {
    const root = await newTenant("escrow-a", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const open = await req("POST", "/api/escrow", { token: root.token, body: openBody() });
    expect(open.status).toBe(201);
    expect(open.json.escrow.state).toBe("open");
    expect(open.json.escrow.amount).toBe(500);
    expect(open.json.escrow.denom).toBe("mesh");
    expect(open.json.escrow.payee_tenant).toBe("t_payee");
    expect(typeof open.json.token).toBe("string"); // the custodian's own grant token
    // the HOLD: the payer's remaining dropped by exactly the committed amount
    expect((await remainingOf(root.token)).usd_cents).toBe(before - 500);
    // and it reads back by its grant id
    const got = await req("GET", "/api/escrow/" + open.json.escrow.grant_id, { token: root.token });
    expect(got.status).toBe(200);
    expect(got.json.escrow.state).toBe("open");
    expect(got.json.escrow.amount).toBe(500);
  });

  test("CONTROL: a usd (real-money) escrow is refused at the door — money-out is a hard floor", async () => {
    const root = await newTenant("escrow-usd", "pro");
    const r = await req("POST", "/api/escrow", { token: root.token, body: openBody({ denom: "usd" }) });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("escrow_usd_gated");
  });

  test("CONTROL: an unknown condition kind is refused (no un-satisfiable escrow can be opened)", async () => {
    const root = await newTenant("escrow-cond", "pro");
    const r = await req("POST", "/api/escrow", { token: root.token, body: openBody({ condition: { kind: "whenever" } }) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("escrow_condition_unknown");
  });

  test("CONTROL: amount and payee_tenant are required", async () => {
    const root = await newTenant("escrow-req", "pro");
    expect((await req("POST", "/api/escrow", { token: root.token, body: openBody({ amount: 0 }) })).json.error).toBe("escrow_amount_required");
    expect((await req("POST", "/api/escrow", { token: root.token, body: openBody({ payee_tenant: "" }) })).json.error).toBe("escrow_payee_tenant_required");
  });

  test("CONTROL: held value is un-spendable while escrowed — the payer cannot spend it elsewhere", async () => {
    const root = await newTenant("escrow-lock", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const open = await req("POST", "/api/escrow", { token: root.token, body: openBody({ amount: before }) }); // hold ALL usd
    expect(open.status).toBe(201);
    expect((await remainingOf(root.token)).usd_cents).toBe(0);
    // now a child needing even 1 cent must be refused — the value is locked in the escrow.
    // (the attenuation gate catches the over-budget child first, at 403, with the reason in detail)
    const child = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:x", caps: ["grant.read"], ttlSec: 3600, budget: { usd_cents: 1, calls: 1, deploys: 0 } } });
    expect(child.status).toBe(403);
    expect(child.json.detail).toContain("budget_exceeds_parent_remaining");
  });

  test("refund via revoke returns the held value to the payer and flips the escrow to refunded", async () => {
    const root = await newTenant("escrow-refund", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const open = await req("POST", "/api/escrow", { token: root.token, body: openBody() });
    expect((await remainingOf(root.token)).usd_cents).toBe(before - 500);
    // revoke the custodian grant -> release-to-parent (the refund path; timed auto-refund lands with the reaper, PR #24)
    const rev = await req("POST", "/api/grants/" + open.json.escrow.grant_id + "/revoke", { token: root.token, body: { reason: "test refund" } });
    expect(rev.status).toBe(200);
    expect((await remainingOf(root.token)).usd_cents).toBe(before); // held value back in full
    const got = await req("GET", "/api/escrow/" + open.json.escrow.grant_id, { token: root.token });
    expect(got.json.escrow.state).toBe("refunded");
  });

  test("CONTROL: opening an escrow requires the escrow.hold cap", async () => {
    const root = await newTenant("escrow-cap", "pro");
    // a child WITHOUT escrow.hold cannot open an escrow
    const child = await req("POST", "/api/grants", { token: root.token, body: { sub: "agent:noesc", caps: ["grant.read"], ttlSec: 3600, budget: { usd_cents: 1000, calls: 2, deploys: 0 } } });
    expect(child.status).toBe(201);
    const r = await req("POST", "/api/escrow", { token: child.json.token, body: openBody({ amount: 100 }) });
    expect(r.status).toBe(403);
  });

  // POST /api/escrow hands the custodian's token back to the payer. The custodian's one capability
  // is escrow.hold (a marker), which is also the capability this route asks for, so that token used
  // to open a SECOND hold out of the held value. Captured, the two paid out twice what was paid in.
  test("CONTROL: a hold cannot pay for another hold — the custodian's own token opens nothing", async () => {
    const root = await newTenant("escrow-nest", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const outer = await req("POST", "/api/escrow", { token: root.token, body: openBody({ amount: 100 }) });
    expect(outer.status).toBe(201);
    expect((await req("GET", "/api/grants/verify", { token: outer.json.token })).json.caps).toEqual(["escrow.hold"]);
    // Refused whatever the request says, good or bad: who is asking is checked first.
    for (const over of [{}, { amount: 1 }, { condition: { kind: "receipt:mesh" } }, { payee_tenant: "t_other" }, { amount: 0 }, { deadline: "soon" }]) {
      const inner = await req("POST", "/api/escrow", { token: outer.json.token, body: openBody({ amount: 100, ...over }) });
      expect([JSON.stringify(over), inner.status, inner.json.error]).toEqual([JSON.stringify(over), 403, "escrow_custodian_cannot_pay"]);
    }
    // Nothing was pledged out of the hold, and the payer is out exactly the one hold.
    expect((await remainingOf(outer.json.token)).usd_cents).toBe(100);
    expect((await remainingOf(root.token)).usd_cents).toBe(before - 100);
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [outer.json.escrow.grant_id])).rows[0].n).toBe(0);
    // The payer's own key still opens holds as before.
    expect((await req("POST", "/api/escrow", { token: root.token, body: openBody({ amount: 100 }) })).status).toBe(201);
  });

  test("CONTROL: a hold opened on the owner's approval cannot pay for another hold either, and nothing is filed", async () => {
    const root = await newTenant("escrow-nest-ask", "pro");
    const asker = await req("POST", "/api/grants", {
      token: root.token,
      body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec: 3600, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
    });
    expect(asker.status).toBe(201);
    const filed = await req("POST", "/api/escrow", { token: asker.json.token, body: openBody({ amount: 100 }) });
    expect(filed.status).toBe(202);
    const ok = await req("POST", `/api/approvals/${filed.json.approval.id}`, { token: root.token, body: { decision: "approve" } });
    expect(ok.json.status).toBe("executed");
    // The hold's token inherits the "ask" dial. It must be refused BEFORE anything is filed for the owner.
    const inner = await req("POST", "/api/escrow", { token: ok.json.result.token, body: openBody({ amount: 100 }) });
    expect([inner.status, inner.json.error]).toEqual([403, "escrow_custodian_cannot_pay"]);
    expect((await req("GET", "/api/approvals", { token: root.token })).json.approvals.length).toBe(1); // only the one that ran
    expect((await remainingOf(asker.json.token)).usd_cents).toBe(400);
  });

  // A request a hold's own token filed BEFORE this rule existed, approved after it: the approval
  // runs the same check (it is in buildEscrow, not only on the route), fails, and opens nothing.
  test("CONTROL: an approval that a hold's token filed earlier opens nothing when the owner approves it", async () => {
    const root = await newTenant("escrow-nest-old-ask", "pro");
    const outer = await req("POST", "/api/escrow", { token: root.token, body: openBody({ amount: 100 }) });
    expect(outer.status).toBe(201);
    await dbQuery("INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, requested_by) VALUES ($1, $2, $3, 'escrow.open', $4::jsonb, 1, 'escrow:agent:q')",
      ["ap_old_hold_ask", root.id, outer.json.escrow.grant_id, JSON.stringify(openBody({ amount: 100 }))]);
    const ok = await req("POST", "/api/approvals/ap_old_hold_ask", { token: root.token, body: { decision: "approve" } });
    expect([ok.status, ok.json.error]).toEqual([403, "escrow_custodian_cannot_pay"]);
    const row = (await req("GET", "/api/approvals", { token: root.token })).json.approvals.find((a) => a.id === "ap_old_hold_ask");
    expect(row.status).toBe("failed");
    expect((await dbQuery("SELECT count(*)::int AS n FROM grants WHERE parent = $1", [outer.json.escrow.grant_id])).rows[0].n).toBe(0);
    expect((await remainingOf(outer.json.token)).usd_cents).toBe(100);
  });

  test("CONTROL: a plain grant is not an escrow; an unknown id is not found", async () => {
    const root = await newTenant("escrow-notesc", "pro");
    expect((await req("GET", "/api/escrow/" + root.grantId, { token: root.token })).status).toBe(404); // the root grant is not an escrow
    expect((await req("GET", "/api/escrow/gr_nope", { token: root.token })).status).toBe(404);
  });
});

describe("20. A2A Agent Card (Phase 1: /.well-known/agent.json)", () => {
  const getCard = () => req("GET", "/.well-known/agent.json"); // NO token — discovery is keyless
  // Import src modules DYNAMICALLY (after the harness has set env + booted the app), never at the
  // test file's top level — a static import evaluates config.js before the harness sets env, which
  // silently changes runtime config (e.g. the rate limit). Cached, so this is cheap.
  const a2a = () => import("../src/a2a.js");
  const mcpMod = () => import("../src/mcp.js");

  test("AC#1: the card fetches with no auth, as application/json, cacheable", async () => {
    const r = await getCard();
    expect(r.status).toBe(200);
    expect(String(r.headers.get("content-type") || "")).toContain("application/json");
    expect(String(r.headers.get("cache-control") || "")).toContain("max-age");
    expect(r.json.name).toBeTruthy();
    expect(r.json.provider.organization).toBe("RightOnPar LLC");
  });

  test("AC#2: the card validates against the pinned A2A v1.0.1 contract", async () => {
    const { validateAgentCard } = await a2a();
    const r = await getCard();
    expect(validateAgentCard(r.json)).toEqual([]);
    // spot-check the v1.0.x shape: transport in supportedInterfaces, no top-level id/url
    expect(Array.isArray(r.json.supportedInterfaces)).toBe(true);
    expect(r.json.id).toBeUndefined();
    expect(r.json.url).toBeUndefined();
    expect(r.json.skills.every((s) => Array.isArray(s.tags) && s.tags.length > 0)).toBe(true); // tags REQUIRED
  });

  test("AC#3: every interface URL in the card is a live route (nothing listed is dead)", async () => {
    const r = await getCard();
    for (const iface of r.json.supportedInterfaces) {
      const path = new URL(iface.url).pathname;
      const probe = await req("GET", path); // no token; a live route answers (not 404)
      expect(probe.status).not.toBe(404);
    }
  });

  test("AC#4: the auth section matches the enforced reality", async () => {
    // discovery is keyless (proven above); the interface it advertises (/mcp) is grant-gated:
    // a POST with no grant is rejected, matching the card's grantBearer requirement.
    const r = await getCard();
    expect(r.json.securityRequirements[0].schemes.grantBearer).toBeDefined();
    const gated = await req("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(gated.status).toBe(401);
  });

  test("AC#4b: drift — the card's skills are exactly the MCP tool registry", async () => {
    const { MCP_TOOLS } = await mcpMod();
    const r = await getCard();
    const ids = r.json.skills.map((s) => s.id).sort();
    const tools = MCP_TOOLS.map((t) => t.name).sort();
    expect(ids).toEqual(tools);
  });

  test("AC#5: a stock A2A client can enumerate skills with no runtime-specific code", async () => {
    const r = await getCard();
    expect(r.json.skills.length).toBeGreaterThan(0);
    for (const s of r.json.skills) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
    }
  });
});

describe("21. escrow capture (stage 2: receipt:mesh -> payee credit)", () => {
  const remainingOf = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining;
  const meshReceipt = (obj) => { const m = JSON.stringify(obj); return req("POST", "/webhooks/mesh", { raw: m, headers: { "x-mesh-signature": hmacHex(MESH_SECRET, m) } }); };
  const openEscrow = (token, over = {}) => req("POST", "/api/escrow", { token, body: { amount: 500, payee_tenant: "t_payee", condition: { kind: "receipt:mesh" }, ...over } });
  const creditRows = async (payee, escrowId) => (await dbQuery("SELECT count(*)::int AS n, coalesce(sum(usd_cents),0)::int AS cents FROM ledger WHERE tenant=$1 AND kind='mesh-credit' AND ref=$2", [payee, escrowId])).rows[0];
  const setSetting = (k, v) => dbQuery("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [k, v]);
  // Capture is an operator-gated value movement (review 2026-09-27): OFF by default, so these tests
  // enable it. The gate + kill-switch behaviour is itself tested below.
  beforeAll(() => setSetting("escrow_capture", "on"));
  afterAll(async () => { await setSetting("escrow_capture", "off"); await setSetting("kill_switch", "off"); });

  test("a signed delivery receipt captures: escrow->captured, payer settled (not refunded), payee credited in MESH", async () => {
    const root = await newTenant("cap-a", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeA" });
    expect(open.status).toBe(201);
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    expect((await remainingOf(root.token)).usd_cents).toBe(before - 500); // held
    const r = await meshReceipt({ receipt_id: "rc-A1", escrow_id: esId, capability: "delivered" });
    expect(r.status).toBe(202);
    expect(r.json.escrow.captured).toBe(true);
    // captured, not refunded: the held value became a SPEND, so remaining stays down (not restored)
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("captured");
    expect((await remainingOf(root.token)).usd_cents).toBe(before - 500);
    // payee credited exactly the amount, once
    expect(await creditRows("t_payeeA", esId)).toEqual({ n: 1, cents: 500 });
    // the payer's spend is on the ledger too
    expect((await dbQuery("SELECT count(*)::int AS n FROM ledger WHERE grant_id=$1 AND kind='escrow-capture'", [gid])).rows[0].n).toBe(1);
    // provenance: the mesh-credit row records the triggering receipt id (auditor can trace it back)
    expect((await dbQuery("SELECT note FROM ledger WHERE tenant=$1 AND kind='mesh-credit' AND ref=$2", ["t_payeeA", esId])).rows[0].note).toContain("receipt=rc-A1");
  });

  test("CONTROL: double-capture is impossible — a second receipt credits the payee ZERO more", async () => {
    const root = await newTenant("cap-dup", "pro");
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeD" });
    const esId = open.json.escrow.id;
    expect((await meshReceipt({ receipt_id: "rc-D1", escrow_id: esId })).json.escrow.captured).toBe(true);
    // a fresh receipt (new id) for the same escrow: webhook processes it, capture no-ops
    const second = await meshReceipt({ receipt_id: "rc-D2", escrow_id: esId });
    expect(second.json.escrow.captured).toBe(false);
    // a replayed receipt (same id) is dropped as a replay before capture is even reached
    expect((await meshReceipt({ receipt_id: "rc-D1", escrow_id: esId })).json.replay).toBe(true);
    expect(await creditRows("t_payeeD", esId)).toEqual({ n: 1, cents: 500 }); // credited exactly once
  });

  test("CONTROL: capture and refund are mutually exclusive — a captured escrow cannot be refunded", async () => {
    const root = await newTenant("cap-vs-refund", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeX" });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    expect((await meshReceipt({ receipt_id: "rc-X1", escrow_id: esId })).json.escrow.captured).toBe(true);
    // now try to refund via revoke: it must NOT re-credit the payer (escrow is captured, not active)
    const rev = await req("POST", "/api/grants/" + gid + "/revoke", { token: root.token, body: { reason: "late refund attempt" } });
    expect(rev.json.revoked).not.toContain(gid); // revoke skips the non-active escrow
    expect((await remainingOf(root.token)).usd_cents).toBe(before - 500); // still spent, never returned
  });

  test("CONTROL: a refunded escrow cannot be captured — the payee is NOT credited", async () => {
    const root = await newTenant("refund-vs-cap", "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeR" });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    // refund first (revoke) -> value returns to payer
    await req("POST", "/api/grants/" + gid + "/revoke", { token: root.token, body: { reason: "failed" } });
    expect((await remainingOf(root.token)).usd_cents).toBe(before);
    // a delivery receipt now must NOT capture (escrow already refunded)
    const r = await meshReceipt({ receipt_id: "rc-R1", escrow_id: esId });
    expect(r.json.escrow.captured).toBe(false);
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("refunded");
    expect(await creditRows("t_payeeR", esId)).toEqual({ n: 0, cents: 0 });
  });

  test("CONTROL: capture requires a matching escrow and the right condition", async () => {
    const root = await newTenant("cap-cond", "pro");
    // no escrow_id in the receipt -> no capture attempted
    expect((await meshReceipt({ receipt_id: "rc-N1", amount: 10 })).json.escrow).toBeNull();
    // unknown escrow id -> declined
    expect((await meshReceipt({ receipt_id: "rc-N2", escrow_id: "es_nope" })).json.escrow.captured).toBe(false);
    // ref-bound escrow: a receipt whose capability != the bound ref must NOT capture
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeC", condition: { kind: "receipt:mesh", ref: "job-42" } });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    const bad = await meshReceipt({ receipt_id: "rc-N3", escrow_id: esId, capability: "job-99" });
    expect(bad.json.escrow.captured).toBe(false);
    expect(bad.json.escrow.reason).toBe("ref_mismatch");
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("open");
    // the matching ref DOES capture
    expect((await meshReceipt({ receipt_id: "rc-N4", escrow_id: esId, capability: "job-42" })).json.escrow.captured).toBe(true);
  });

  test("CONTROL: an attestation:self-settle escrow does not capture on a mesh receipt (wrong condition)", async () => {
    const root = await newTenant("cap-wrongcond", "pro");
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeW", condition: { kind: "attestation:self-settle" } });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    const r = await meshReceipt({ receipt_id: "rc-W1", escrow_id: esId });
    expect(r.json.escrow.captured).toBe(false);
    expect(r.json.escrow.reason).toBe("condition_mismatch");
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("open");
  });

  test("CONTROL (fix): capture is gated — OFF by default, and the kill switch stops it", async () => {
    const root = await newTenant("cap-gate", "pro");
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeG" });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    // gate OFF -> a signed receipt does NOT capture (no off-switch would be a HIGH finding)
    await setSetting("escrow_capture", "off");
    expect((await meshReceipt({ receipt_id: "rc-G1", escrow_id: esId })).json.escrow).toBeNull();
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("open");
    // gate ON but kill switch ON -> still no capture
    await setSetting("escrow_capture", "on");
    await setSetting("kill_switch", "on");
    expect((await meshReceipt({ receipt_id: "rc-G2", escrow_id: esId })).json.escrow).toBeNull();
    await setSetting("kill_switch", "off"); // restore BEFORE any gated read (reads are 503 while paused)
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("open");
  });

  test("CONTROL (fix): capture is retry-safe — a receipt that could not capture, retried, still captures", async () => {
    const root = await newTenant("cap-retry", "pro");
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeRT" });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    // first delivery arrives while capture is disabled: the receipt_id is RECORDED, but no capture
    await setSetting("escrow_capture", "off");
    expect((await meshReceipt({ receipt_id: "rc-RT1", escrow_id: esId })).json.escrow).toBeNull();
    // re-enable, and the SAME receipt_id is retried: recordWebhookEvent sees a replay, but capture
    // is attempted BEFORE the replay short-circuit, so the escrow still captures (durability fix).
    await setSetting("escrow_capture", "on");
    const retry = await meshReceipt({ receipt_id: "rc-RT1", escrow_id: esId });
    expect(retry.json.replay).toBe(true);
    expect(retry.json.escrow.captured).toBe(true);
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("captured");
    expect(await creditRows("t_payeeRT", esId)).toEqual({ n: 1, cents: 500 });
  });

  // A hold under a hold cannot be opened any more (section 19), so these tests build the rows an
  // older one would have left: two holds opened side by side, then the second moved under the
  // first. What capture, refund and the sweep read is then as the first hold's own token would
  // have left it: parent, depth, and the second hold's reservation held on the first, not on
  // the payer. (Fields none of them reads are left as they were: issued_by, the stored token,
  // the note of the payer inside the hold's own mark, the reserve row in the ledger.)
  const nested = async (name, outerAmount, innerAmount) => {
    const root = await newTenant(name, "pro");
    const before = (await remainingOf(root.token)).usd_cents;
    const outer = await openEscrow(root.token, { amount: outerAmount, payee_tenant: "t_outer_" + name });
    const inner = await openEscrow(root.token, { amount: innerAmount, payee_tenant: "t_inner_" + name });
    expect([outer.status, inner.status]).toEqual([201, 201]);
    const held = async (id) => { const v = (await dbQuery("SELECT reserved FROM grants WHERE id = $1", [id])).rows[0].reserved; return typeof v === "string" ? JSON.parse(v) : v || {}; };
    const setHeld = (id, r) => dbQuery("UPDATE grants SET reserved = $2::jsonb WHERE id = $1", [id, JSON.stringify({ usd_cents: r.usd_cents || 0, calls: r.calls || 0, deploys: r.deploys || 0 })]);
    const p = await held(root.grantId), o = await held(outer.json.escrow.grant_id);
    await setHeld(root.grantId, { ...p, usd_cents: p.usd_cents - innerAmount });
    await setHeld(outer.json.escrow.grant_id, { ...o, usd_cents: (o.usd_cents || 0) + innerAmount });
    await dbQuery("UPDATE grants SET parent = $2, depth = depth + 1 WHERE id = $1", [inner.json.escrow.grant_id, outer.json.escrow.grant_id]);
    // It reads as nested: the payer is out the outer amount only, and the outer hold has pledged the inner amount on.
    expect((await remainingOf(root.token)).usd_cents).toBe(before - outerAmount);
    expect((await remainingOf(outer.json.token)).usd_cents).toBe(outerAmount - innerAmount);
    const credited = async (payee) => (await dbQuery("SELECT coalesce(sum(usd_cents),0)::int AS cents FROM ledger WHERE tenant=$1 AND kind='mesh-credit'", [payee])).rows[0].cents;
    return {
      root, before, outer: outer.json.escrow, inner: inner.json.escrow,
      paid: async () => before - (await remainingOf(root.token)).usd_cents,
      // how the payer's own row books it: what it settled itself, and what is still held on it
      books: async () => {
        const row = (await dbQuery("SELECT reserved, settled FROM grants WHERE id = $1", [root.grantId])).rows[0];
        const cents = (v) => (typeof v === "string" ? JSON.parse(v) : v || {}).usd_cents || 0;
        return { settled: cents(row.settled), held: cents(row.reserved) };
      },
      credits: async () => ({ outer: await credited("t_outer_" + name), inner: await credited("t_inner_" + name) }),
      stateOf: async (e) => (await req("GET", "/api/escrow/" + e.grant_id, { token: root.token })).json.escrow.state,
    };
  };
  let rc = 0;
  const receiptFor = (escrow) => meshReceipt({ receipt_id: "rc-nest-" + ++rc, escrow_id: escrow.id });

  // This is the bug as it was found: outer hold 100, inner hold 100 opened with the outer hold's
  // token, both captured. Payees were credited 200 for a payer who paid 100.
  test("CONTROL: two captures never credit more than the payer paid — a hold fully pledged to a hold below pays nothing itself", async () => {
    const n = await nested("nest-full", 100, 100);
    const first = await receiptFor(n.outer); // the outer hold's delivery arrives first
    expect(first.json.escrow).toMatchObject({ captured: false, reason: "pledged_to_a_hold_below" });
    expect(await n.stateOf(n.outer)).toBe("open"); // it waits; it did not end as a capture of nothing
    expect((await receiptFor(n.inner)).json.escrow).toMatchObject({ captured: true, amount: 100 });
    const again = await receiptFor(n.outer); // and now its value has been paid out below
    expect(again.json.escrow).toMatchObject({ captured: false, reason: "nothing_left_to_capture" });
    expect(await n.stateOf(n.outer)).toBe("open"); // still open: it did not end as a capture of nothing
    expect(await n.credits()).toEqual({ outer: 0, inner: 100 });
    expect(await n.paid()).toBe(100);
  });

  test("CONTROL: a hold partly pledged below pays only the rest, in either order of delivery", async () => {
    // inner delivered first, then outer
    const a = await nested("nest-part-a", 100, 40);
    expect((await receiptFor(a.inner)).json.escrow).toMatchObject({ captured: true, amount: 40 });
    expect((await receiptFor(a.outer)).json.escrow).toMatchObject({ captured: true, amount: 60 });
    expect(await a.credits()).toEqual({ outer: 60, inner: 40 });
    expect(await a.paid()).toBe(100);
    // The payer's own row settles only the 60 its hold captured. The 40 paid out under that hold
    // stays held on the payer, which is how spend below a grant is counted everywhere else.
    expect(await a.books()).toEqual({ settled: 60, held: 40 });
    // and the payer's spend row in the ledger says 60, what was captured, not the hold's whole 100
    expect((await dbQuery("SELECT usd_cents FROM ledger WHERE grant_id = $1 AND kind = 'escrow-capture'", [a.outer.grant_id])).rows.map((r) => r.usd_cents)).toEqual([60]);
    // outer delivered first: it waits while part of it is still pledged, then pays the rest
    const b = await nested("nest-part-b", 100, 40);
    expect((await receiptFor(b.outer)).json.escrow).toMatchObject({ captured: false, reason: "pledged_to_a_hold_below" });
    expect(await b.credits()).toEqual({ outer: 0, inner: 0 });
    expect((await receiptFor(b.inner)).json.escrow).toMatchObject({ captured: true, amount: 40 });
    expect((await receiptFor(b.outer)).json.escrow).toMatchObject({ captured: true, amount: 60 });
    expect(await b.credits()).toEqual({ outer: 60, inner: 40 });
    expect(await b.paid()).toBe(100);
  });

  test("CONTROL: when the hold below is refunded instead, the hold above pays in full, once", async () => {
    const n = await nested("nest-refund", 100, 40);
    const rev = await req("POST", "/api/grants/" + n.inner.grant_id + "/revoke", { token: n.root.token, body: { reason: "inner not delivered" } });
    expect(rev.json.revoked).toContain(n.inner.grant_id);
    expect((await receiptFor(n.outer)).json.escrow).toMatchObject({ captured: true, amount: 100 });
    expect((await receiptFor(n.inner)).json.escrow.captured).toBe(false); // refunded: it can never capture
    expect(await n.credits()).toEqual({ outer: 100, inner: 0 });
    expect(await n.paid()).toBe(100);
  });

  // Any shape of holds under holds, built the same way: each hold in `plan` is { amount, under }
  // where `under` is the index of an earlier hold in the plan, or null for the payer itself.
  const tree = async (name, plan) => {
    const root = await newTenant(name, "pro");
    // Read straight from the payer's row, and refund with the admin key, so a long random run
    // never meets the payer key's own rate limit.
    const left = async () => { const r = (await dbQuery("SELECT budget, reserved, settled FROM grants WHERE id = $1", [root.grantId])).rows[0]; const c = (v) => (typeof v === "string" ? JSON.parse(v) : v || {}).usd_cents || 0; return c(r.budget) - c(r.reserved) - c(r.settled); };
    const before = await left();
    const usage = async (id, col) => { const v = (await dbQuery(`SELECT ${col} FROM grants WHERE id = $1`, [id])).rows[0][col]; return typeof v === "string" ? JSON.parse(v) : v || {}; };
    const addHeld = async (id, by) => { const r = await usage(id, "reserved"); await dbQuery("UPDATE grants SET reserved = $2::jsonb WHERE id = $1", [id, JSON.stringify({ usd_cents: (r.usd_cents || 0) + by, calls: r.calls || 0, deploys: r.deploys || 0 })]); };
    const holds = [];
    for (const [i, h] of plan.entries()) {
      const payee = `t_${name}_${i}`;
      const o = await openEscrow(root.token, { amount: h.amount, payee_tenant: payee });
      expect(o.status).toBe(201);
      const hold = { ...o.json.escrow, payee, amount: h.amount, under: h.under };
      if (h.under !== null) {
        const parent = holds[h.under];
        await addHeld(root.grantId, -h.amount);
        await addHeld(parent.grant_id, h.amount);
        await dbQuery("UPDATE grants SET parent = $2, depth = (SELECT depth + 1 FROM grants WHERE id = $2) WHERE id = $1", [hold.grant_id, parent.grant_id]);
      }
      holds.push(hold);
    }
    const credited = async (payee) => (await dbQuery("SELECT coalesce(sum(usd_cents),0)::int AS cents FROM ledger WHERE tenant=$1 AND kind='mesh-credit'", [payee])).rows[0].cents;
    return {
      root, holds,
      paid: async () => before - (await left()),
      credits: async () => { const out = []; for (const h of holds) out.push(await credited(h.payee)); return out; },
      statusOf: async (h) => (await dbQuery("SELECT status FROM grants WHERE id = $1", [h.grant_id])).rows[0].status,
      revoke: (h) => admin("POST", "/api/admin/grants/" + h.grant_id + "/revoke", { body: { reason: "test refund" } }),
      // its deadline goes by and the sweep runs (the sweep leaves it alone while anything under it is open)
      expire: async (h) => { await dbQuery("UPDATE grants SET exp = $2 WHERE id = $1", [h.grant_id, Math.floor(Date.now() / 1000) - 10]); return admin("POST", "/api/admin/grants/reap"); },
    };
  };

  // A hold keeps what was spent further down HELD (that is how spend below a grant is counted),
  // so "something is held on it" does not mean "something below is still open". With three
  // levels, the top hold used to look pledged for ever and never paid its own share.
  test("CONTROL: three levels deep, each hold pays exactly its own share, whichever delivery comes first", async () => {
    const plan = [{ amount: 100, under: null }, { amount: 40, under: 0 }, { amount: 20, under: 1 }]; // A(100) > B(40) > C(20)
    // bottom up: C 20, B its other 20, A its other 60
    const up = await tree("deep-up", plan);
    expect((await receiptFor(up.holds[2])).json.escrow).toMatchObject({ captured: true, amount: 20 });
    expect((await receiptFor(up.holds[1])).json.escrow).toMatchObject({ captured: true, amount: 20 });
    expect((await receiptFor(up.holds[0])).json.escrow).toMatchObject({ captured: true, amount: 60 });
    expect(await up.credits()).toEqual([60, 20, 20]);
    expect(await up.paid()).toBe(100);
    // top down: each waits for what is still open under it, then pays the same shares
    const down = await tree("deep-down", plan);
    expect((await receiptFor(down.holds[0])).json.escrow).toMatchObject({ captured: false, reason: "pledged_to_a_hold_below" });
    expect((await receiptFor(down.holds[1])).json.escrow).toMatchObject({ captured: false, reason: "pledged_to_a_hold_below" });
    expect((await receiptFor(down.holds[2])).json.escrow).toMatchObject({ captured: true, amount: 20 });
    expect((await receiptFor(down.holds[0])).json.escrow).toMatchObject({ captured: false, reason: "pledged_to_a_hold_below" }); // B is still open
    expect((await receiptFor(down.holds[1])).json.escrow).toMatchObject({ captured: true, amount: 20 });
    expect((await receiptFor(down.holds[0])).json.escrow).toMatchObject({ captured: true, amount: 60 });
    expect(await down.credits()).toEqual([60, 20, 20]);
    expect(await down.paid()).toBe(100);
  });

  // Every shape and every order at once. Random trees of holds under holds (a fixed seed, so a
  // failure repeats), then deliveries, refunds and deadlines in random order until nothing is open.
  // Two things must hold: payees are never credited more than the payer is out, at any moment;
  // and when everything has ended the two are EQUAL (nothing made, nothing lost).
  test("CONTROL: any tree of holds, any order of deliveries and refunds — credits never pass what the payer paid, and end equal to it", async () => {
    // mulberry32: whole-number maths only (Math.imul), so every bit is used and a seed repeats exactly
    let seed = 20261009;
    const rnd = (n) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const shapes = { nested: 0, threeDeep: 0, waited: 0, deliveries: 0, refunds: 0, deadlines: 0 };
    for (let round = 0; round < 24; round++) {
      const plan = [], free = [];
      const count = 2 + rnd(4); // 2 to 5 holds
      for (let i = 0; i < count; i++) {
        const parents = free.map((v, j) => (v >= 2 ? j : -1)).filter((j) => j >= 0);
        const under = i > 0 && parents.length && rnd(4) > 0 ? parents[rnd(parents.length)] : null;
        const amount = under === null ? 20 + rnd(81) : 1 + rnd(free[under] - 1);
        if (under !== null) free[under] -= amount;
        plan.push({ amount, under });
        free.push(amount);
      }
      const depthOf = (i) => (plan[i].under === null ? 1 : 1 + depthOf(plan[i].under));
      const deepest = Math.max(...plan.map((_, i) => depthOf(i)));
      if (deepest >= 2) shapes.nested++;
      if (deepest >= 3) shapes.threeDeep++;
      const t = await tree("fuzz-" + round, plan);
      const total = (xs) => xs.reduce((a, b) => a + b, 0);
      for (let step = 0; step < 60; step++) {
        const open = [];
        for (const h of t.holds) if ((await t.statusOf(h)) === "active") open.push(h);
        if (!open.length) break;
        const h = open[rnd(open.length)];
        const op = rnd(5);
        if (op === 0) (shapes.refunds++, await t.revoke(h));
        else if (op === 1) (shapes.deadlines++, await t.expire(h));
        else {
          const r = await receiptFor(h);
          shapes.deliveries++;
          if (r.json.escrow.reason === "pledged_to_a_hold_below") shapes.waited++;
          // A delivery waits only while something directly under the hold is still open, never
          // because of what was spent further down.
          let openBelow = false;
          for (const c of t.holds) if (c.under === t.holds.indexOf(h) && (await t.statusOf(c)) === "active") openBelow = true;
          expect([round, step, r.json.escrow.reason === "pledged_to_a_hold_below"]).toEqual([round, step, openBelow]);
        }
        expect([round, step, total(await t.credits()) <= (await t.paid())]).toEqual([round, step, true]);
      }
      for (const h of t.holds) if ((await t.statusOf(h)) === "active") await t.revoke(h); // anything still waiting is refunded
      const credits = await t.credits();
      expect([round, JSON.stringify(plan), total(credits)]).toEqual([round, JSON.stringify(plan), await t.paid()]);
      // and no hold ever paid more than its own amount
      for (const [i, h] of t.holds.entries()) expect(credits[i]).toBeLessThanOrEqual(h.amount);
    }
    // The run really did build holds under holds, three deep, and really did make deliveries wait.
    // (A random test that only ever drew flat shapes would pass whatever the code did.)
    expect(shapes.nested).toBeGreaterThan(8);
    expect(shapes.threeDeep).toBeGreaterThan(3);
    expect(shapes.waited).toBeGreaterThan(3);
    expect(shapes.deliveries).toBeGreaterThan(20);
    expect(shapes.refunds).toBeGreaterThan(5);
    expect(shapes.deadlines).toBeGreaterThan(5);
  }, 30000); // about a second here; the default limit of five leaves too little room on a slow machine

  // The same rule on the running build, where no request can make such rows: /selftest.
  test("the runtime's own self-test carries the control: a hold cannot pay for a hold, a capture never pays out what was passed on", async () => {
    const r = await req("GET", "/selftest");
    const name = "payment hold cannot pay for another hold, and a capture never pays out what was passed on";
    expect(r.json.results.find((c) => c.name === name)).toEqual({ name, pass: true });
  });

  test("CONTROL (fix): a receipt naming a different payee does not settle to the escrow's payee", async () => {
    const root = await newTenant("cap-payee", "pro");
    const open = await openEscrow(root.token, { payee_tenant: "t_payeeP" });
    const esId = open.json.escrow.id, gid = open.json.escrow.grant_id;
    const r = await meshReceipt({ receipt_id: "rc-P1", escrow_id: esId, payee_tenant: "t_somebody_else" });
    expect(r.json.escrow.captured).toBe(false);
    expect(r.json.escrow.reason).toBe("payee_mismatch");
    expect((await req("GET", "/api/escrow/" + gid, { token: root.token })).json.escrow.state).toBe("open");
    expect(await creditRows("t_payeeP", esId)).toEqual({ n: 0, cents: 0 });
  });
});

// ------------------------------------------------------------------------------------
describe("22. the autonomy dial (src/autonomy.js)", () => {
  const verify = async (token) => (await req("GET", "/api/grants/verify", { token })).json;
  // A child of `parentToken` with the caps a dial test needs, at the given level (omit = inherit).
  const childAt = (parentToken, autonomy, extra = {}) =>
    req("POST", "/api/grants", {
      token: parentToken,
      body: {
        sub: "agent:dial",
        caps: ["grant.issue", "deploy.worker", "escrow.hold", "ledger.read", "grant.read"],
        ttlSec: 3600,
        budget: { usd_cents: 2000, calls: 10, deploys: 2 },
        ...(autonomy === undefined ? {} : { constraints: { autonomy } }),
        ...extra,
      },
    });
  const escrowBody = { amount: 100, payee_tenant: "t_payee", condition: { kind: "attestation:self-settle" } };

  test("a grant minted without a level is `act` — existing behaviour is unchanged", async () => {
    const root = await newTenant("dial-legacy", "pro");
    expect((await verify(root.token)).constraints.autonomy).toBeUndefined(); // the root row carries no level...
    const c = await childAt(root.token, undefined);
    expect(c.status).toBe(201);
    expect((await verify(c.json.token)).constraints.autonomy).toBe(2); // ...and a child inherits `act`
  });

  test("CONTROL: a child asking for more autonomy than its parent is refused (autonomy_widened)", async () => {
    const root = await newTenant("dial-widen", "pro");
    const asker = await childAt(root.token, "ask");
    expect(asker.status).toBe(201);
    const up = await childAt(asker.json.token, "act");
    expect(up.status).toBe(403);
    expect(up.json).toEqual({ error: "attenuation_violation", detail: ["autonomy_widened"] });
    const same = await childAt(asker.json.token, "ask");
    expect(same.status).toBe(201);
  });

  test("CONTROL: at `ask`, the agent's own confirm:true does NOT deploy — it waits for the owner", async () => {
    const root = await newTenant("dial-ask", "pro");
    const c = await childAt(root.token, "ask");
    const name = (await verify(c.json.token)).scope.workers.namePrefix + "dial-1";
    const d = await req("POST", "/api/deploys", { token: c.json.token, body: { name, template: "probe", confirm: true } });
    expect(d.status).toBe(201);
    expect(d.json.status).toBe("awaiting_approval");
    expect(d.json.executed).toBe(false);
    expect((await req("GET", "/api/deploys", { token: root.token })).json.deploys.length).toBe(0); // nothing planned or run
    const led = (await req("GET", "/api/ledger", { token: root.token })).json.ledger;
    expect(led.some((l) => l.kind === "autonomy-ask" && l.decision === "ask" && l.autonomy === 1)).toBe(true);
  });

  test("CONTROL: only the owner's root grant can approve — a delegated grant cannot, even an `act` one", async () => {
    const root = await newTenant("dial-who", "pro");
    const boss = await childAt(root.token, "act");
    const worker = await childAt(boss.json.token, "ask");
    const d = await req("POST", "/api/escrow", { token: worker.json.token, body: escrowBody });
    expect(d.status).toBe(202);
    const byBoss = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: boss.json.token, body: { decision: "approve" } });
    expect(byBoss.status).toBe(403);
    expect(byBoss.json.error).toBe("owner_approval_required");
  });

  test("the owner approves: the exact escrow opens, and the ledger names the approving human", async () => {
    const root = await newTenant("dial-yes", "pro");
    const rootId = (await verify(root.token)).id;
    const c = await childAt(root.token, "ask");
    const d = await req("POST", "/api/escrow", { token: c.json.token, body: escrowBody });
    const ap = d.json.approval.id;
    const ok = await req("POST", `/api/approvals/${ap}`, { token: root.token, body: { decision: "approve" } });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("executed");
    expect(ok.json.result.escrow.amount).toBe(100);
    const led = (await req("GET", "/api/ledger", { token: root.token })).json.ledger;
    expect(led.some((l) => l.kind === "autonomy-approved" && l.approver === rootId && l.ref === ap)).toBe(true);
    // approving twice is impossible: it is no longer pending
    const again = await req("POST", `/api/approvals/${ap}`, { token: root.token, body: { decision: "approve" } });
    expect(again.status).toBe(404);
  });

  test("the owner denies: nothing runs, and the denial is on the ledger", async () => {
    const root = await newTenant("dial-no", "pro");
    const c = await childAt(root.token, "ask");
    const before = (await verify(c.json.token)).remaining.usd_cents;
    const d = await req("POST", "/api/escrow", { token: c.json.token, body: escrowBody });
    const no = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: root.token, body: { decision: "deny" } });
    expect(no.json.status).toBe("denied");
    expect((await verify(c.json.token)).remaining.usd_cents).toBe(before); // no value held
    const led = (await req("GET", "/api/ledger", { token: root.token })).json.ledger;
    expect(led.some((l) => l.kind === "autonomy-denied" && l.decision === "denied")).toBe(true);
  });

  test("an approved deploy that cannot run says approved_not_run, never executed", async () => {
    const root = await newTenant("dial-norun", "pro");
    const c = await childAt(root.token, "ask");
    const name = (await verify(c.json.token)).scope.workers.namePrefix + "dial-2";
    const d = await req("POST", "/api/deploys", { token: c.json.token, body: { name, template: "probe" } });
    const ok = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: root.token, body: { decision: "approve" } });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("approved_not_run"); // Railway is unarmed under test
  });

  test("CONTROL: `observe` refuses value actions outright, and the refusal is recorded", async () => {
    const root = await newTenant("dial-obs", "pro");
    const c = await childAt(root.token, "observe");
    const r = await req("POST", "/api/escrow", { token: c.json.token, body: escrowBody });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("autonomy_observe_only");
    const led = (await req("GET", "/api/ledger", { token: root.token })).json.ledger;
    expect(led.some((l) => l.kind === "autonomy-refused" && l.decision === "refuse" && l.autonomy === 0)).toBe(true);
  });

  test("turning the dial down cascades to the subtree; turning it up is refused", async () => {
    const root = await newTenant("dial-down", "pro");
    const mid = await childAt(root.token, "act");
    const leaf = await childAt(mid.json.token, "act");
    const midId = (await verify(mid.json.token)).id;
    const down = await req("POST", `/api/grants/${midId}/autonomy`, { token: root.token, body: { level: "ask" } });
    expect(down.status).toBe(200);
    expect(down.json).toMatchObject({ from: "act", to: "ask", grantsChanged: 2 });
    expect((await verify(leaf.json.token)).constraints.autonomy).toBe(1); // the leaf came down too
    const up = await req("POST", `/api/grants/${midId}/autonomy`, { token: root.token, body: { level: "act" } });
    expect(up.status).toBe(403);
    expect(up.json.error).toBe("raise_requires_new_grant");
  });

  test("CONTROL: a grant cannot turn the dial of a grant outside its own subtree", async () => {
    const root = await newTenant("dial-reach", "pro");
    const a = await childAt(root.token, "act");
    const b = await childAt(root.token, "act");
    const bId = (await verify(b.json.token)).id;
    const r = await req("POST", `/api/grants/${bId}/autonomy`, { token: a.json.token, body: { level: "observe" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("not_in_your_subtree");
  });
});

// ------------------------------------------------------------------------------------
describe("23. agent-host (docs/specs/agent-host.md)", () => {
  const verify = async (token) => (await req("GET", "/api/grants/verify", { token })).json;
  const mkHost = (rootToken, body = {}) => req("POST", "/api/hosts", { token: rootToken, body: { name: "desk", ...body } });
  const hire = (hostToken, sub = "agent:worker", extra = {}) =>
    req("POST", "/api/grants", { token: hostToken, body: { sub, caps: ["grant.read"], ttlSec: 3600, budget: { usd_cents: 10, calls: 5, deploys: 0 }, ...extra } });

  test("only the owner's root grant, on pro and up, can create a host", async () => {
    const starter = await newTenant("host-starter", "starter");
    const s = await mkHost(starter.token);
    expect(s.status).toBe(403);
    expect(s.json.error).toBe("host_tier_too_low");
    const pro = await newTenant("host-owner", "pro");
    const child = await req("POST", "/api/grants", { token: pro.token, body: { sub: "agent:x", caps: ["grant.issue"], ttlSec: 600, budget: { usd_cents: 10, calls: 5, deploys: 0 } } });
    const byChild = await mkHost(child.json.token);
    expect(byChild.status).toBe(403);
    expect(byChild.json.error).toBe("owner_required");
    const bad = await mkHost(pro.token, { name: "has space" });
    expect(bad.json.error).toBe("bad_host_name");
  });

  test("a new host defaults to dial `ask`, 10 sub-agents, 2 levels, and cannot spend on machines", async () => {
    const root = await newTenant("host-defaults", "pro");
    const h = await mkHost(root.token, { name: "research" });
    expect(h.status).toBe(201);
    expect(h.json.host).toMatchObject({ name: "research", sub: "host:research", autonomy: "ask", limits: { maxSubagents: 10, maxDepthBelow: 2 } });
    expect(h.json.host.caps).toContain("grant.issue");
    expect(h.json.host.caps).not.toContain("deploy.worker");
    expect(h.json.machine.template).toBe("agent-host");
  });

  test("a hire is named agent:<host>/<role> and inherits the host's dial; it cannot ask for more", async () => {
    const root = await newTenant("host-hire", "pro");
    const h = await mkHost(root.token);
    const w = await hire(h.json.token, "agent:scraper");
    expect(w.status).toBe(201);
    const v = await verify(w.json.token);
    expect(v.sub).toBe(`agent:${h.json.host.id}/scraper`);
    expect(v.constraints.autonomy).toBe(1); // `ask`, inherited
    const up = await hire(h.json.token, "agent:bold", { constraints: { autonomy: "act" } });
    expect(up.status).toBe(403);
    expect(up.json.detail).toEqual(["autonomy_widened"]);
  });

  test("CONTROL: the sub-agent ceiling refuses one hire too many, records it, and frees up on revoke", async () => {
    const root = await newTenant("host-cap", "pro");
    const h = await mkHost(root.token, { maxSubagents: 2 });
    const a = await hire(h.json.token, "agent:a");
    const b = await hire(h.json.token, "agent:b");
    expect([a.status, b.status]).toEqual([201, 201]);
    const c = await hire(h.json.token, "agent:c");
    expect(c.status).toBe(403);
    expect(c.json).toEqual({ error: "attenuation_violation", detail: ["host_subagents_exceeded"] });
    const led = (await req("GET", "/api/ledger", { token: root.token })).json.ledger;
    expect(led.some((l) => l.kind === "host-refused" && l.decision === "refuse" && l.ref === h.json.host.id)).toBe(true);
    // a revoked hire no longer counts: the slot opens up again
    const aId = (await verify(a.json.token)).id;
    await req("POST", `/api/grants/${aId}/revoke`, { token: root.token, body: {} });
    expect((await hire(h.json.token, "agent:c")).status).toBe(201);
  });

  test("CONTROL: the depth ceiling refuses a hire one level too deep", async () => {
    const root = await newTenant("host-depth", "pro");
    const h = await mkHost(root.token, { maxDepthBelow: 1 });
    const lead = await hire(h.json.token, "agent:lead", { caps: ["grant.issue", "grant.read"] });
    expect(lead.status).toBe(201);
    const deeper = await hire(lead.json.token, "agent:helper");
    expect(deeper.status).toBe(403);
    expect(deeper.json.detail).toEqual(["host_depth_exceeded"]);
  });

  test("the hiring tree shows the host, its hires and their dials — to the host and above only", async () => {
    const root = await newTenant("host-tree", "pro");
    const h = await mkHost(root.token);
    const w = await hire(h.json.token, "agent:one");
    await hire(h.json.token, "agent:two");
    const tree = await req("GET", `/api/hosts/${h.json.host.id}`, { token: root.token });
    expect(tree.status).toBe(200);
    expect(tree.json.host.limits).toEqual({ maxSubagents: 10, maxDepthBelow: 2 });
    expect(tree.json.hires.map((g) => g.autonomy)).toEqual(["ask", "ask"]);
    expect(tree.json.live).toBe(2);
    expect((await req("GET", `/api/hosts/${h.json.host.id}`, { token: h.json.token })).status).toBe(200);
    expect((await req("GET", `/api/hosts/${h.json.host.id}`, { token: w.json.token })).json.error).toBe("not_in_your_subtree");
    expect((await req("GET", `/api/hosts/gr_nope`, { token: root.token })).status).toBe(404);
  });

  test("revoke drill: revoking the host stops every hire and returns the budget to the owner", async () => {
    const root = await newTenant("host-revoke", "pro");
    const before = (await verify(root.token)).remaining;
    const h = await mkHost(root.token);
    const a = await hire(h.json.token, "agent:a");
    const b = await hire(h.json.token, "agent:b");
    const rv = await req("POST", `/api/grants/${h.json.host.id}/revoke`, { token: root.token, body: {} });
    expect(rv.json.revoked.length).toBe(3); // the host and both hires
    for (const tok of [h.json.token, a.json.token, b.json.token]) expect((await req("GET", "/api/grants/verify", { token: tok })).status).toBe(401);
    expect((await verify(root.token)).remaining).toEqual(before);
  });
});

describe("24. stored deploy secrets never leave the runtime (bridge prerequisite, 2026-10-09)", () => {
  // A deploy's stored intent is the caller's request body; its env carries real
  // values (other services' keys). GET /api/deploys/:id and GET /api/approvals
  // must return the variable NAMES only, so the front door can bridge them.
  const SECRET = "sk_live_must_not_leave_" + Date.now();
  const verify = async (token) => (await req("GET", "/api/grants/verify", { token })).json;

  test("GET /api/deploys/:id returns env names, never values", async () => {
    const t = await newTenant("deploy-redact");
    const name = (await verify(t.token)).scope.workers.namePrefix + "redact-1";
    const d = await req("POST", "/api/deploys", { token: t.token, body: { name, template: "probe", env: { STRIPE_SECRET_KEY: SECRET, PORT: "8080" }, api_token: SECRET } });
    expect(d.status).toBe(201);
    const got = await req("GET", `/api/deploys/${d.json.id}`, { token: t.token });
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.json)).not.toContain(SECRET);
    expect(got.json.deploy.intent.env).toEqual({ STRIPE_SECRET_KEY: "[redacted]", PORT: "[redacted]" });
    expect(got.json.deploy.intent.api_token).toBe("[redacted]");
    expect(got.json.deploy.intent.template).toBe("probe"); // non-secret fields untouched
    // ...and the stored row still holds the real value (an approved deploy must run with it).
    const row = (await dbQuery("SELECT intent FROM deploys WHERE id = $1", [d.json.id])).rows[0];
    expect(JSON.stringify(row.intent)).toContain(SECRET);
  });

  test("GET /api/approvals returns a pending deploy's env names, never values", async () => {
    const root = await newTenant("approvals-redact", "pro");
    const c = await req("POST", "/api/grants", {
      token: root.token,
      body: { sub: "agent:redact", caps: ["deploy.worker"], ttlSec: 3600, budget: { usd_cents: 2000, calls: 10, deploys: 2 }, constraints: { autonomy: "ask" } },
    });
    expect(c.status).toBe(201);
    const name = (await verify(c.json.token)).scope.workers.namePrefix + "redact-2";
    const d = await req("POST", "/api/deploys", { token: c.json.token, body: { name, template: "probe", confirm: true, env: { DB_PASSWORD: SECRET } } });
    expect(d.json.status).toBe("awaiting_approval");
    const list = await req("GET", "/api/approvals", { token: root.token });
    expect(list.status).toBe(200);
    expect(list.json.approvals.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.json)).not.toContain(SECRET);
    expect(list.json.approvals[0].intent.env).toEqual({ DB_PASSWORD: "[redacted]" });
  });
});
