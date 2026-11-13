import { test, expect, afterAll } from "bun:test";
import { newTenant, req, mcp, shutdown, dbQuery } from "./harness.js";
import { stagingProfile, assertStagingGrant } from "../src/staging-gateway.js";
afterAll(shutdown);
const config = {
  MCP_GATEWAY_PROFILE: "staging-v1", RUNTIME_ENV: "staging",
  MCP_STAGING_PROJECT_ID: "project-staging",
  MCP_STAGING_ENVIRONMENT_ID: "env-staging",
  MCP_STAGING_TENANT_ID: "fixture",
};
test("profile fails closed for production, missing pins and typos", () => {
  expect(stagingProfile({})).toBe(false);
  expect(stagingProfile(config)).toBe(true);
  for (const patch of [{ RUNTIME_ENV: "production" }, { MCP_STAGING_TENANT_ID: "" },
    { MCP_STAGING_PROJECT_ID: "" }, { MCP_STAGING_ENVIRONMENT_ID: "" },
    { MCP_GATEWAY_PROFILE: "typo" }]) {
    expect(() => stagingProfile({ ...config, ...patch })).toThrow("staging_gateway_misconfigured");
  }
});
test("grant envelope rejects broad, long, foreign and root grants", () => {
  const row = { tenant: "fixture", parent: "root", iat: 100, exp: 1000,
    caps: ["memory.read"], scope: { railway: { projects: ["project-staging"], environments: ["env-staging"] } } };
  const auth = r => ({ row: r, tenant: { id: "fixture" } });
  expect(() => assertStagingGrant(auth(row), config, 101)).not.toThrow();
  for (const patch of [{ parent: null }, { tenant: "other" }, { exp: 1001 },
    { exp: 100 }, { iat: 102 }, { caps: ["memory.write"] },
    { scope: { railway: { projects: ["project-staging"], environments: ["production"] } } },
    { scope: { railway: { projects: ["project-staging", "prod"], environments: ["env-staging"] } } }])
    expect(() => assertStagingGrant(auth({ ...row, ...patch }), config, 101)).toThrow("staging_grant_required");
});
test("existing MCP route: scoped list, no writes, receipt per call, atomic call budget, revocation", async () => {
  const t = await newTenant("staging-gateway");
  await dbQuery("UPDATE grants SET scope = $1::jsonb WHERE id = $2",
    [JSON.stringify({ railway: { projects: ["project-staging"], environments: ["env-staging"] },
      workers: { namePrefix: "staging-" }, memory: { partitions: ["notes"] } }), t.grantId]);
  const child = await req("POST", "/api/grants", { token: t.token, body: {
    sub: "agent:staging-auditor", ttlSec: 900, caps: ["memory.read"],
    budget: { usd_cents: 0, calls: 2, deploys: 0 }
  } });
  expect(child.status).toBe(201);
  Object.assign(process.env, config, { MCP_STAGING_TENANT_ID: t.id });
  try {
    expect((await mcp(t.token, "initialize")).status).toBe(403);
    const listed = await mcp(child.json.token, "tools/list");
    expect(listed.json.result.tools.map(t => t.name).sort()).toEqual(["grant_verify", "memory_search", "runtime_health"]);
    const denied = await mcp(child.json.token, "tools/call", { name: "memory_write", arguments: { content: "forbidden" } });
    expect(JSON.parse(denied.json.result.content[0].text).error).toBe("staging_tool_denied");
    expect(denied.headers.get("x-runtime-receipt")).toBeTruthy();
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      mcp(child.json.token, "tools/call", { name: "grant_verify" })));
    expect(results.filter(r => !r.json.result.isError)).toHaveLength(2);
    expect(results.filter(r => r.json.result.isError)).toHaveLength(1);
    expect(results.every(r => r.headers.get("x-runtime-receipt"))).toBe(true);
    const charge = await dbQuery("SELECT sum(calls)::int AS n FROM ledger WHERE grant_id = $1 AND kind = 'settle'", [child.json.id]);
    expect(charge.rows[0].n).toBe(2);
    const receipts = await dbQuery("SELECT outcome FROM tool_receipts WHERE grant_id = $1", [child.json.id]);
    expect(receipts.rows.filter(r => r.outcome === "succeeded")).toHaveLength(2);
    expect(receipts.rows.filter(r => r.outcome === "denied")).toHaveLength(2);
    await dbQuery("UPDATE grants SET status = 'revoked' WHERE id = $1", [child.json.id]);
    expect((await mcp(child.json.token, "tools/call", { name: "grant_verify" })).status).toBe(401);
    const guest = await mcp(null, "tools/call", { name: "guest_welcome" });
    expect(guest.status).toBe(403);
  } finally {
    for (const key of Object.keys(config)) delete process.env[key];
  }
});
