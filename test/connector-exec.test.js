// 0.3.3 connector exec switch (src/connector.js). Runs in its own process
// (test/run.mjs runs each suite file separately), against its own throwaway DB.
import { afterAll, describe, expect, test } from "bun:test";
import { admin, dbQuery, newTenant, req, s256, shutdown } from "./harness.js";

afterAll(shutdown);

const BASE_CAPS = ["grant.issue", "grant.read", "cog.plan", "ledger.read"];
const EXEC = ["cog.execute", "lsp.diagnose"];
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const setExec = (on) => admin("POST", "/api/admin/connector-exec", { body: { on } });
const capsOf = async (token) => (await req("GET", "/api/grants/verify", { token })).json?.caps;
const issue = (token, body) => req("POST", "/api/grants", { token, body });

// The claude.ai connector's real path: DCR -> admin approval -> PKCE code exchange.
async function connect(tenant) {
  const reg = await req("POST", "/oauth/register", { body: { client_name: "claude", redirect_uris: [REDIRECT] } });
  expect(reg.status).toBe(201);
  const verifier = "connector-exec-verifier-".padEnd(60, "x");
  const ap = await admin("POST", "/oauth/approve", {
    body: { client_id: reg.json.client_id, redirect_uri: REDIRECT, code_challenge: s256(verifier), state: "s", tenant },
  });
  expect(ap.status).toBe(200);
  const code = new URL(ap.json.redirect).searchParams.get("code");
  const tok = await req("POST", "/oauth/token", {
    body: { grant_type: "authorization_code", code, client_id: reg.json.client_id, redirect_uri: REDIRECT, code_verifier: verifier },
  });
  expect(tok.status).toBe(200);
  return tok.json;
}

describe("connector exec switch", () => {
  test("admin only, starts off, validates input", async () => {
    expect((await req("GET", "/api/admin/connector-exec")).status).toBe(401);
    expect((await req("POST", "/api/admin/connector-exec", { body: { on: true } })).status).toBe(401);
    const r = await admin("GET", "/api/admin/connector-exec");
    expect(r.status).toBe(200);
    expect(r.json.on).toBe(false);
    expect(r.json.caps).toEqual(EXEC);
    expect((await admin("POST", "/api/admin/connector-exec", { body: { on: "yes" } })).status).toBe(400);
    expect((await admin("GET", "/api/admin/connector-exec")).json.on).toBe(false);
    const page = await req("GET", "/admin/connector");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Connector exec");
  });

  test("off: sign-in gets the base caps; on: it gets both, and the consent page says so", async () => {
    const t = await newTenant("cx-signin", "pro");
    expect((await setExec(false)).json.on).toBe(false);
    const a = await connect(t.id);
    expect(a.scope.split(" ")).toEqual(BASE_CAPS);
    expect(await capsOf(a.access_token)).toEqual(BASE_CAPS);

    const on = await setExec(true);
    expect(on.status).toBe(200);
    expect(on.json.on).toBe(true);
    const b = await connect(t.id);
    expect(b.scope.split(" ")).toEqual([...BASE_CAPS, ...EXEC]);
    expect(await capsOf(b.access_token)).toEqual([...BASE_CAPS, ...EXEC]);

    const reg = await req("POST", "/oauth/register", { body: { client_name: "c", redirect_uris: [REDIRECT] } });
    const consent = await req(
      "GET",
      `/oauth/authorize?client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${s256("v")}&response_type=code`,
    );
    expect(consent.status).toBe(200);
    expect(consent.text).toContain("cog.execute, lsp.diagnose");

    const st = await admin("GET", "/api/admin/connector-exec");
    expect(st.json.operatorGrants.some((g) => g.carries.length === 2)).toBe(true);
    expect(st.json.operatorGrants.some((g) => g.carries.length === 0)).toBe(true);
  });

  test("off bites on the next call: the connector and everything it minted lose both caps", async () => {
    const t = await newTenant("cx-mask", "pro");
    await setExec(true);
    const op = await connect(t.id);
    const child = await issue(op.access_token, { sub: "agent:helper", caps: ["lsp.diagnose"], ttlSec: 600, budget: { calls: 5 } });
    expect(child.status).toBe(201);
    expect(await capsOf(child.json.token)).toEqual(["lsp.diagnose"]);

    await setExec(false);
    expect(await capsOf(op.access_token)).toEqual(BASE_CAPS);
    expect(await capsOf(child.json.token)).toEqual([]);
    const ex = await req("POST", "/api/cog/execute", { token: op.access_token, body: { proposal: { grants: [], deploys: [] } } });
    expect(ex.status).toBe(403);
    expect(ex.json.error).toBe("missing_cap");
    const again = await issue(op.access_token, { sub: "agent:helper2", caps: ["lsp.diagnose"], ttlSec: 600, budget: { calls: 1 } });
    expect(again.status).toBe(403);

    await setExec(true);
    expect(await capsOf(child.json.token)).toEqual(["lsp.diagnose"]);
  });

  test("grants outside the connector's lineage keep both caps while off", async () => {
    const t = await newTenant("cx-other", "pro");
    await setExec(false);
    expect(await capsOf(t.token)).toEqual(expect.arrayContaining(EXEC));
    const g = await issue(t.token, { sub: "agent:builder", caps: ["lsp.diagnose", "cog.execute"], ttlSec: 600, budget: { calls: 3 } });
    expect(g.status).toBe(201);
    expect(await capsOf(g.json.token)).toEqual(["lsp.diagnose", "cog.execute"]);
  });

  test("on: approving a connector on a pre-0.3.2 root mints a root that can pass the caps down", async () => {
    const t = await newTenant("cx-oldroot", "pro");
    await dbQuery(`UPDATE grants SET caps = (caps - 'cog.execute' - 'lsp.diagnose') WHERE id = $1`, [t.grantId]);
    await setExec(true);
    const c = await connect(t.id);
    expect(c.scope.split(" ")).toEqual([...BASE_CAPS, ...EXEC]);
    const all = await admin("GET", "/api/admin/grants");
    expect(all.json.grants.filter((g) => g.tenant === t.id && g.depth === 0).length).toBe(2);
  });

  test("off: approval leaves a pre-0.3.2 root alone", async () => {
    const t = await newTenant("cx-oldroot-off", "pro");
    await dbQuery(`UPDATE grants SET caps = (caps - 'cog.execute' - 'lsp.diagnose') WHERE id = $1`, [t.grantId]);
    await setExec(false);
    const c = await connect(t.id);
    expect(c.scope.split(" ")).toEqual(BASE_CAPS);
    const all = await admin("GET", "/api/admin/grants");
    expect(all.json.grants.filter((g) => g.tenant === t.id && g.depth === 0).length).toBe(1);
  });
});
