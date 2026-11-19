// Own process: real HTTP/OAuth/grant code over the throwaway harness database.
// No external network, real credentials, live grants or tenant mutations.
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { admin, req, newTenant, shutdown, dbQuery, s256, BASE, blockedFetches } from "./harness.js";
import { PROOF_CAPS, PROOF_REDIRECT, PROOF_RUNTIME, PROOF_ROOT_SUB, PROOF_SUB } from "../src/proof-oauth.js";

afterAll(shutdown);
let tenant, client, counter = 0;
const verifier = "proof-fixture-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
const limits = () => ({ caps: [...PROOF_CAPS], scope: { memory: { partitions: ["product:devdesk"] } },
  budget: { usd_cents: 0, calls: 40, deploys: 0 }, ttlSec: 14400 });
const mint = (body = { sub: PROOF_ROOT_SUB, proof_limits: limits() }) =>
  admin("POST", "/api/tenants/" + tenant.id + "/root-grant", { body });
const approve = (extra = {}) => admin("POST", "/oauth/approve", { body: {
  tenant: tenant.id, client_id: client, redirect_uri: PROOF_REDIRECT,
  code_challenge: s256(verifier), code_challenge_method: "S256", state: "proof-fixture-state", ...extra,
} });
const exchange = (code, extra = {}) => req("POST", "/oauth/token", { body: {
  grant_type: "authorization_code", client_id: client, redirect_uri: PROOF_REDIRECT,
  code, code_verifier: verifier, ...extra,
} });
const refresh = (token, extra = {}) => req("POST", "/oauth/token", { body: {
  grant_type: "refresh_token", client_id: client, refresh_token: token, ...extra,
} });
const rows = () => dbQuery("SELECT id,parent,depth,sub,status,caps,scope,budget,reserved,settled,exp,payload FROM grants WHERE tenant=$1 ORDER BY id", [tenant.id]);
const codes = () => dbQuery("SELECT hash FROM oauth_codes WHERE tenant=$1 ORDER BY hash", [tenant.id]);
const decode = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
async function lease() {
  const root = await mint(); expect(root.status).toBe(201);
  const approved = await approve(); expect(approved.status).toBe(200);
  const code = new URL(approved.json.redirect).searchParams.get("code");
  const token = await exchange(code); expect(token.status).toBe(200);
  return { root: root.json, token: token.json, code };
}

beforeEach(async () => {
  tenant = await newTenant("proof-fixture-" + (++counter), "starter");
  Object.assign(Bun.env, { PUBLIC_URL: PROOF_RUNTIME, DEVDESK_PROOF_ENABLED: "1",
    DEVDESK_PROOF_TENANT: tenant.id, DEVDESK_PROOF_REDIRECT_URI: PROOF_REDIRECT });
  const registration = await req("POST", "/oauth/register", { body: {
    client_name: "DevDesk proof fixture", redirect_uris: [PROOF_REDIRECT],
  } });
  expect(registration.status).toBe(201);
  client = registration.json.client_id;
});
afterEach(() => {
  for (const key of ["DEVDESK_PROOF_ENABLED", "DEVDESK_PROOF_TENANT", "DEVDESK_PROOF_REDIRECT_URI"]) delete Bun.env[key];
  Bun.env.PUBLIC_URL = BASE;
});

test("proof approval cannot reuse a broad root or automatically mint one", async () => {
  const before = (await rows()).rows;
  const r = await approve();
  expect(r.status).toBe(409); expect(r.json.error).toBe("bounded_root_required");
  expect((await rows()).rows).toEqual(before);
  expect((await codes()).rows.length).toBe(0);
});

test("owner bounded root response, row and signed payload have identical limits", async () => {
  const before = (await rows()).rows;
  const r = await mint(); expect(r.status).toBe(201);
  const payload = decode(r.json.token);
  expect(payload.sub).toBe(PROOF_ROOT_SUB);
  expect(payload.caps).toEqual([...PROOF_CAPS]);
  expect(payload.scope.memory.partitions).toEqual(["product:devdesk"]);
  expect(payload.scope.railway).toEqual({ projects: [], environments: [] });
  expect(payload.budget).toEqual({ usd_cents: 0, calls: 40, deploys: 0 });
  expect(payload.exp - payload.iat).toBe(14400);
  for (const key of ["sub", "caps", "scope", "budget", "constraints", "exp"]) expect(r.json[key]).toEqual(payload[key]);
  const after = (await rows()).rows;
  expect(after.filter((row) => row.id !== r.json.id)).toEqual(before);
  const stored = after.find((row) => row.id === r.json.id);
  for (const key of ["caps", "scope", "budget", "constraints"]) {
    const q = await dbQuery("SELECT " + key + " AS value FROM grants WHERE id=$1", [stored.id]);
    expect(q.rows[0].value).toEqual(payload[key]);
  }
  const verified = await req("GET", "/api/grants/verify", { token: r.json.token });
  expect(verified.status).toBe(200); expect(verified.json.budget).toEqual(payload.budget);
});

test("misplaced, unknown or widening root inputs do not write grants or allocations", async () => {
  const before = (await rows()).rows;
  const bad = [
    { caps: [...PROOF_CAPS], budget: { usd_cents: 0, calls: 40, deploys: 0 } },
    { proof_limits: { ...limits(), extra: true } },
    { proof_limits: { ...limits(), caps: [...PROOF_CAPS, "deploy.worker"] } },
    { proof_limits: { ...limits(), budget: { usd_cents: 1, calls: 40, deploys: 0 } } },
    { proof_limits: { ...limits(), budget: { usd_cents: 0, calls: "40", deploys: 0 } } },
    { proof_limits: { ...limits(), scope: { memory: { partitions: [""] } } } },
    { proof_limits: { ...limits(), ttlSec: 14401 } },
  ];
  for (const body of bad) expect((await mint(body)).status).toBe(400);
  expect((await rows()).rows).toEqual(before);
});

test("legacy root requests and ordinary operator OAuth keep their existing contract", async () => {
  const root = await mint({ sub: "tenant:ordinary" });
  expect(root.status).toBe(201); expect(decode(root.json.token).caps).toContain("grant.issue");
  expect(Object.keys(root.json).sort()).toEqual(["exp", "id", "token"]);
  const redirect = "https://claude.ai/proof-fixture/callback";
  const c = await req("POST", "/oauth/register", { body: { redirect_uris: [redirect] } });
  const a = await approve({ client_id: c.json.client_id, redirect_uri: redirect });
  expect(a.status).toBe(200);
  const t = await exchange(new URL(a.json.redirect).searchParams.get("code"), { client_id: c.json.client_id, redirect_uri: redirect });
  expect(t.status).toBe(200); expect(decode(t.json.access_token).sub).toBe("agent:claude-operator");
});

test("exact proof callback, deployment origin and configured tenant are enforced", async () => {
  const before = (await rows()).rows;
  for (const redirect of [PROOF_REDIRECT + "?x=1", PROOF_REDIRECT + "/", PROOF_REDIRECT.replace("https:", "http:"),
      PROOF_REDIRECT.replace("/runtime/callback", "/other")]) {
    const r = await req("POST", "/oauth/register", { body: { redirect_uris: [redirect] } });
    expect(r.status).toBe(400);
  }
  const other = await newTenant("proof-other", "starter");
  expect((await approve({ tenant: other.id })).status).toBe(403);
  Bun.env.PUBLIC_URL = "https://runtime.meshtool.ai";
  expect((await mint()).status).toBe(503);
  expect((await approve()).status).toBe(503);
  expect((await rows()).rows).toEqual(before);
});

test("disabled proof cannot become operator even for an already registered client", async () => {
  await mint();
  const before = (await rows()).rows;
  Bun.env.DEVDESK_PROOF_ENABLED = "0";
  expect((await approve()).status).toBe(403);
  expect((await mint()).status).toBe(403);
  expect((await rows()).rows).toEqual(before);
  expect((await codes()).rows.length).toBe(0);
});

test("proof OAuth override-looking fields are refused rather than ignored", async () => {
  await mint();
  for (const key of ["scope", "caps", "budget", "root_id", "proof_limits", "profile"])
    expect((await approve({ [key]: {} })).status).toBe(400);
  expect((await codes()).rows.length).toBe(0);
});

test("PKCE exchange yields only the bounded child and one-hour starter lease", async () => {
  const { root, token } = await lease();
  const payload = decode(token.access_token);
  expect(payload.parent).toBe(root.id); expect(payload.depth).toBe(1);
  expect(payload.sub).toBe(PROOF_SUB); expect(payload.caps).toEqual([...PROOF_CAPS]);
  expect(payload.scope.memory.partitions).toEqual(["product:devdesk"]);
  expect(payload.budget).toEqual({ usd_cents: 0, calls: 40, deploys: 0 });
  expect(token.expires_in).toBeGreaterThan(0); expect(token.expires_in).toBeLessThanOrEqual(3600);
  const verified = await req("GET", "/api/grants/verify", { token: token.access_token });
  expect(verified.status).toBe(200); expect(verified.json.tenant).toBe(tenant.id);
  expect((await req("POST", "/api/grants", { token: token.access_token, body: { caps: ["memory.read"] } })).status).toBe(403);
  expect((await req("POST", "/api/deploys", { token: token.access_token, body: {} })).status).toBe(403);
});

test("proof memory works only in the approved partition", async () => {
  const { token } = await lease();
  const own = await req("POST", "/api/memory", { token: token.access_token,
    body: { partition: "product:devdesk", key: "proof-fixture", content: "checkpoint fixture" } });
  expect(own.status).toBe(201);
  expect((await req("GET", "/api/memory/" + own.json.memory.id, { token: token.access_token })).status).toBe(200);
  expect((await req("GET", "/api/memory?partition=agent:other", { token: token.access_token })).status).toBe(403);
});

test("wrong PKCE verifier and reused authorization codes cannot issue another child", async () => {
  await mint();
  const a = await approve(); expect(a.status).toBe(200);
  const code = new URL(a.json.redirect).searchParams.get("code");
  expect((await exchange(code, { code_verifier: "wrong" })).status).toBe(400);
  expect((await exchange(code)).status).toBe(400);
  expect((await rows()).rows.filter((row) => Number(row.depth) === 1).length).toBe(0);
  const b = await approve();
  const code2 = new URL(b.json.redirect).searchParams.get("code");
  expect((await exchange(code2)).status).toBe(200);
  expect((await exchange(code2)).status).toBe(400);
  expect((await rows()).rows.filter((row) => Number(row.depth) === 1).length).toBe(1);
});

test("refresh rotates once without reminting, extending or reserving the 40 calls twice", async () => {
  const { token } = await lease();
  const before = (await rows()).rows;
  const r = await refresh(token.refresh_token); expect(r.status).toBe(200);
  expect(r.json.refresh_token).not.toBe(token.refresh_token);
  expect(decode(r.json.access_token)).toEqual(decode(token.access_token));
  expect((await rows()).rows).toEqual(before);
  const consent = await dbQuery("SELECT consent_until FROM oauth_refresh WHERE client_id=$1 AND revoked=false", [client]);
  expect(Number(consent.rows[0].consent_until)).toBeLessThanOrEqual(decode(token.access_token).exp);
});

test("spent refresh-token replay still revokes the current chain", async () => {
  const { token } = await lease();
  const next = await refresh(token.refresh_token); expect(next.status).toBe(200);
  expect((await refresh(token.refresh_token)).status).toBe(400);
  expect((await refresh(next.json.refresh_token)).status).toBe(400);
  const verified = await req("GET", "/api/grants/verify", { token: next.json.access_token });
  expect([401, 403]).toContain(verified.status);
});

test("natural child expiry cannot create a replacement child or revive its lease", async () => {
  const { token } = await lease();
  const before = (await rows()).rows, realNow = Date.now;
  try {
    const future = (decode(token.access_token).exp + 1) * 1000;
    Date.now = () => future;
    expect((await refresh(token.refresh_token)).status).toBe(400);
  } finally { Date.now = realNow; }
  expect((await rows()).rows).toEqual(before);
});

test("revoked parent between approval and exchange refuses issuance", async () => {
  const root = await mint(); expect(root.status).toBe(201);
  const a = await approve(); expect(a.status).toBe(200);
  expect((await admin("POST", "/api/admin/grants/" + root.json.id + "/revoke", { body: { reason: "proof fixture" } })).status).toBe(200);
  expect((await exchange(new URL(a.json.redirect).searchParams.get("code"))).status).toBe(400);
  expect((await rows()).rows.filter((row) => Number(row.depth) === 1).length).toBe(0);
  expect((await approve()).status).toBe(409);
});

test("disabled proof after approval or issue never falls through to legacy issuance", async () => {
  await mint();
  const a = await approve(); expect(a.status).toBe(200);
  Bun.env.DEVDESK_PROOF_ENABLED = "0";
  expect((await exchange(new URL(a.json.redirect).searchParams.get("code"))).status).toBe(403);
  expect((await rows()).rows.filter((row) => Number(row.depth) === 1).length).toBe(0);
  Bun.env.DEVDESK_PROOF_ENABLED = "1";
  const b = await approve(), t = await exchange(new URL(b.json.redirect).searchParams.get("code"));
  expect(t.status).toBe(200);
  const before = (await rows()).rows;
  Bun.env.DEVDESK_PROOF_ENABLED = "0";
  expect((await refresh(t.json.refresh_token)).status).toBe(400);
  expect((await rows()).rows).toEqual(before);
});

test("ambiguous eligible proof roots refuse approval instead of choosing a broader one", async () => {
  expect((await mint()).status).toBe(201);
  expect((await mint()).status).toBe(201);
  const r = await approve();
  expect(r.status).toBe(409); expect(r.json.error).toBe("bounded_root_ambiguous");
  expect((await codes()).rows.length).toBe(0);
});

test("no proof test made an outbound service call", () => {
  expect(blockedFetches).toEqual([]);
});
