// Characterisation suite for creator-os-runtime. Written against the UNSPLIT
// src/runtime.js (the proven-readable form of the live 0.3.0 bundle) so that any
// refactor has to keep every behaviour pinned here.
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mod, entryPath, BASE, ADMIN_KEY, GITHUB_SECRET, BRAIN_SECRET, MESH_SECRET, RAILWAY_TOKEN, RATE_LIMIT,
  blockedFetches, req, admin, hmacHex, sha256Hex, s256, newTenant, mcp, shutdown,
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
    expect(h.version).toBe("0.3.0");
    expect(h.policy).toBe("p1");
    expect(h.db).toBe(true);
    expect(h.killSwitch).toBe(false);
    expect(h.armed).toEqual({
      admin: true, vault: true, railway: false, railwayOAuth: false, stripe: false,
      railwayWebhook: true, github: true, brain: true, mesh: true, anthropic: false,
      brainOut: false, cognitiveBridge: false, sync: false,
    });
    expect(Object.keys(h.fingerprints).sort()).toEqual(
      ["admin", "anthropic", "brain", "cognitiveBridge", "github", "mesh", "railway", "railwayWebhook", "stripe", "sync", "vault"],
    );
    expect(h.fingerprints.admin).toBe(sha256Hex(ADMIN_KEY).slice(0, 8));
    expect(h.fingerprints.anthropic).toBeNull();
    expect(typeof h.time).toBe("string");
  });

  test("source hash is the sha256 of the file that was loaded as the entry", async () => {
    const r = await req("GET", "/health?chunks=1");
    const text = readFileSync(entryPath, "utf8");
    expect(r.json.source.sha256).toBe(sha256Hex(text));
    expect(r.json.source.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(r.json.source.chunks.length).toBe(Math.ceil(text.length / 4096));
  });

  test("exports", () => {
    expect(mod.VERSION).toBe("0.3.0");
    expect(typeof mod.app.fetch).toBe("function");
    expect(typeof mod.gatehouseEvaluate).toBe("function");
    expect(typeof mod.attenuationViolations).toBe("function");
    expect(Object.keys(mod.TIERS)).toEqual(["starter", "pro", "studio", "house"]);
    expect(Object.keys(mod.TEMPLATES)).toEqual(
      ["probe", "tip-alert-bot", "paywall-link", "clip-poster", "dm-autoresponder", "webhook-relay"],
    );
    expect(mod.CAPS.length).toBe(20);
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
    expect(r.json.version).toBe("0.3.0");
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
      scopes_supported: ["grant.issue", "grant.read", "cog.plan", "ledger.read"],
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
    expect(ok.json.scope).toBe("memory.read memory.write ledger.read tenant.read");
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
    expect(r.json.caps).toEqual(["memory.read", "memory.write", "ledger.read", "tenant.read"]);
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
    expect(again.json.error_description).toBe("refresh token invalid");
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
    expect(i.json.result.serverInfo).toEqual({ name: "creator-os-runtime", version: "0.3.0" });
    expect(i.json.result.protocolVersion).toBe("2025-06-18");
    const l = await mcp(t.token, "tools/list", {}, 2);
    expect(l.json.id).toBe(2);
    expect(l.json.result.tools.map((x) => x.name)).toEqual([
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
    expect(h.json.result.structuredContent.version).toBe("0.3.0");
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
    // the admin key is also accepted via the x-grant header (bearerToken falls back to it)
    expect((await req("GET", "/api/admin/overview", { headers: { "x-grant": ADMIN_KEY } })).status).toBe(200);
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
    expect((await req("POST", "/webhooks/railway?token=wrong", { body: rw })).status).toBe(401);
    const ro = await req("POST", "/webhooks/railway?token=" + RAILWAY_TOKEN, { body: rw });
    expect(ro.json).toEqual({ received: true, result: { matched: 0, status: "deploy" } });

    const s = await req("POST", "/webhooks/stripe", { raw: "{}" });
    expect(s.status).toBe(503);
    expect(s.json.detail).toEqual({ needs: "STRIPE_WEBHOOK_SECRET" });
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

  test("status report runs; every outbound call was blocked and is a known probe", async () => {
    const s = await req("GET", "/status.json");
    expect(s.status).toBe(200);
    expect(s.json.version).toBe("0.3.0");
    expect(s.json.bodies.map((b) => b.up)).toEqual([false, false, false]);
    const allowed = new Set([
      "https://devdesk.meshtool.ai/health", "https://market.meshtool.ai/api/health",
      "https://mcp-gate-production.up.railway.app/health", "https://devdesk.meshtool.ai/runtime/status",
    ]);
    expect(blockedFetches.length).toBeGreaterThan(0);
    for (const u of blockedFetches) expect(allowed.has(u)).toBe(true);
  });
});
