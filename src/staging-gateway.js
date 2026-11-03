// Opt-in envelope over the existing MCP handler; grants and receipts remain runtime-owned.
import { HttpError, parseJson } from "./util.js";

export const STAGING_TOOLS = Object.freeze({
  runtime_health: null,
  grant_verify: null,
  tool_receipts: "ledger.read",
  ledger_query: "ledger.read",
  memory_search: "memory.read",
});
const CAPS = new Set(["ledger.read", "memory.read"]);
export function stagingProfile(env) {
  if (!env.MCP_GATEWAY_PROFILE) return false;
  if (env.MCP_GATEWAY_PROFILE !== "staging-v1" || env.RUNTIME_ENV !== "staging" ||
      !env.MCP_STAGING_PROJECT_ID || !env.MCP_STAGING_ENVIRONMENT_ID || !env.MCP_STAGING_TENANT_ID)
    throw new HttpError(503, "staging_gateway_misconfigured");
  return true;
}
export function assertStagingGrant(auth, env, now = Math.floor(Date.now() / 1000)) {
  if (!stagingProfile(env)) return;
  const g = auth.row, scope = parseJson(g.scope), caps = parseJson(g.caps);
  const exact = (v, expected) => Array.isArray(v) && v.length === 1 && v[0] === expected;
  if (g.tenant !== env.MCP_STAGING_TENANT_ID || auth.tenant.id !== g.tenant ||
      !g.parent || !Number.isFinite(Number(g.iat)) || !Number.isFinite(Number(g.exp)) ||
      Number(g.iat) > now || Number(g.exp) <= now || Number(g.exp) - Number(g.iat) > 900 ||
      !Array.isArray(caps) || caps.some(c => !CAPS.has(c)) ||
      !exact(scope.railway?.projects, env.MCP_STAGING_PROJECT_ID) ||
      !exact(scope.railway?.environments, env.MCP_STAGING_ENVIRONMENT_ID))
    throw new HttpError(403, "staging_grant_required");
}
export function stagingTools(tools, auth, env) {
  if (!stagingProfile(env)) return tools;
  assertStagingGrant(auth, env);
  const caps = parseJson(auth.row.caps);
  return tools.filter(t => Object.hasOwn(STAGING_TOOLS, t.name) &&
    (!STAGING_TOOLS[t.name] || caps.includes(STAGING_TOOLS[t.name])));
}
export function assertStagingTool(name, auth, env) {
  if (!stagingProfile(env)) return;
  assertStagingGrant(auth, env);
  if (!Object.hasOwn(STAGING_TOOLS, name)) throw new HttpError(403, "staging_tool_denied");
}
