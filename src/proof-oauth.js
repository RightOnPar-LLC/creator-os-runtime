// Owner-authorized, finite DevDesk proof connection. These are ceilings, not
// caller-selected OAuth scopes. The reserved callback can NEVER become operator.
import { HttpError, nowSec, parseJson } from "./util.js";

export const PROOF_RUNTIME = "https://staging-runtime.meshtool.ai";
export const PROOF_REDIRECT = "https://chatgpt-devdesk.meshtool.ai/runtime/callback";
export const PROOF_ROOT_SUB = "tenant:devdesk-proof";
export const PROOF_SUB = "product:devdesk-proof";
export const PROOF_CAPS = Object.freeze(["memory.read", "memory.write", "ledger.read", "tenant.read"]);
export const PROOF_PARTITIONS = Object.freeze(["product:devdesk"]);
export const PROOF_PROFILE = Object.freeze({
  sub: PROOF_SUB, label: "DevDesk staging proof", caps: PROOF_CAPS,
  parts: PROOF_PARTITIONS, usd: 0, calls: 40, deploys: 0,
  ttl: 86400, consent: 86400, finiteProof: true,
});

const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x, allowed, code) => {
  if (!object(x) || Object.keys(x).some((key) => !allowed.includes(key))) throw new HttpError(400, code);
};
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const exactList = (x, expected) => Array.isArray(x) && x.length === expected.length &&
  new Set(x).size === x.length && x.every((item) => expected.includes(item));
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : object(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, canonical(x[key])])) : x;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function isProofRedirect(value) {
  try { return new URL(value).hostname === "chatgpt-devdesk.meshtool.ai"; }
  catch { return false; }
}

export function proofConfig(env) {
  if (env.DEVDESK_PROOF_ENABLED !== "1") throw new HttpError(403, "proof_disabled");
  if (env.PUBLIC_URL !== PROOF_RUNTIME || env.DEVDESK_PROOF_REDIRECT_URI !== PROOF_REDIRECT ||
      !/^t_[A-Za-z0-9_-]{1,60}$/.test(env.DEVDESK_PROOF_TENANT || ""))
    throw new HttpError(503, "proof_configuration_invalid");
  return { tenant: env.DEVDESK_PROOF_TENANT };
}

export function proofProfileForRedirect(value, env) {
  proofConfig(env);
  if (value !== PROOF_REDIRECT) throw new HttpError(400, "proof_redirect_mismatch");
  return PROOF_PROFILE;
}

export function rejectProofOAuthOverrides(body) {
  for (const key of ["caps", "budget", "scope", "profile", "root_id", "root_limits", "proof_limits", "resource"])
    if (Object.hasOwn(body, key)) throw new HttpError(400, "proof_parameter_not_supported", { parameter: key });
}

export function validateRootGrantBody(body) {
  keys(body, ["sub", "proof_limits"], "root_grant_parameter_not_supported");
  if (Object.hasOwn(body, "proof_limits")) {
    if (body.sub !== undefined && body.sub !== PROOF_ROOT_SUB) throw new HttpError(400, "proof_root_subject_required");
  } else if (body.sub === PROOF_ROOT_SUB) throw new HttpError(400, "proof_limits_required");
}

export function validateProofRootLimits(limits, tenant, tier, env) {
  const config = proofConfig(env);
  if (tenant.id !== config.tenant || tenant.status !== "active") throw new HttpError(403, "proof_tenant_mismatch");
  keys(limits, ["caps", "scope", "budget", "ttlSec"], "proof_limits_invalid");
  if (!exactList(limits.caps, PROOF_CAPS)) throw new HttpError(400, "proof_caps_invalid");
  keys(limits.scope, ["memory"], "proof_scope_invalid");
  keys(limits.scope.memory, ["partitions"], "proof_scope_invalid");
  if (!exactList(limits.scope.memory.partitions, PROOF_PARTITIONS)) throw new HttpError(400, "proof_scope_invalid");
  keys(limits.budget, ["usd_cents", "calls", "deploys"], "proof_budget_invalid");
  if (limits.budget.usd_cents !== 0 || limits.budget.deploys !== 0 || !integer(limits.budget.calls, 1, 40))
    throw new HttpError(400, "proof_budget_invalid");
  if (!tier || !integer(limits.ttlSec, 60, tier.maxTtlSec * 4)) throw new HttpError(400, "proof_ttl_invalid");
  return {
    caps: [...PROOF_CAPS], memory: { partitions: [...PROOF_PARTITIONS] },
    budget: { usd_cents: 0, calls: limits.budget.calls, deploys: 0 }, ttlSec: limits.ttlSec,
    constraints: { maxWorkers: 0, maxReplicas: 1, allowDelete: false, requireDryRun: true, autonomy: "ask" },
    marker: { version: 1, purpose: "devdesk-proof", tenant: config.tenant, runtime: PROOF_RUNTIME, redirect_uri: PROOF_REDIRECT },
  };
}

function matchesPayload(row) {
  try {
    const payload = parseJson(row.payload);
    return ["id", "tenant", "parent", "sub"].every((key) => payload[key] === row[key]) &&
      Number(payload.depth) === Number(row.depth) && Number(payload.exp) === Number(row.exp) &&
      ["caps", "scope", "budget", "constraints"].every((key) => equal(payload[key], parseJson(row[key])));
  } catch { return false; }
}

export function proofRootProblem(row, env, now = nowSec()) {
  const config = proofConfig(env);
  try {
    if (!row || row.tenant !== config.tenant || row.sub !== PROOF_ROOT_SUB || Number(row.depth) !== 0 || row.parent !== null ||
        row.status !== "active" || Number(row.exp) <= now || !matchesPayload(row)) return "proof_root_inactive";
    const caps = parseJson(row.caps), scope = parseJson(row.scope), budget = parseJson(row.budget), constraints = parseJson(row.constraints);
    if (!exactList(caps, PROOF_CAPS) || !exactList(scope.memory?.partitions, PROOF_PARTITIONS) ||
        !equal(scope.railway, { projects: [], environments: [] }) ||
        !equal(scope.proof, { version: 1, purpose: "devdesk-proof", tenant: config.tenant, runtime: PROOF_RUNTIME, redirect_uri: PROOF_REDIRECT }) ||
        budget.usd_cents !== 0 || budget.deploys !== 0 || !integer(budget.calls, 1, 40) ||
        constraints.maxWorkers !== 0 || constraints.maxReplicas !== 1 || constraints.allowDelete !== false || constraints.requireDryRun !== true ||
        constraints.autonomy !== "ask") return "proof_root_bounds_invalid";
    return null;
  } catch { return "proof_root_bounds_invalid"; }
}

export function proofChildProblem(row, root, tenant, env, now = nowSec()) {
  const rootProblem = proofRootProblem(root, env, now);
  if (rootProblem) return rootProblem;
  try {
    if (!tenant || tenant.id !== root.tenant || tenant.status !== "active" || !row || row.status !== "active" ||
        row.sub !== PROOF_SUB || row.tenant !== root.tenant || row.parent !== root.id || Number(row.depth) !== 1 ||
        Number(row.exp) <= now || Number(row.exp) > Number(root.exp) || !matchesPayload(row)) return "proof_child_inactive";
    const caps = parseJson(row.caps), scope = parseJson(row.scope), budget = parseJson(row.budget), constraints = parseJson(row.constraints);
    if (!exactList(caps, PROOF_CAPS) || !exactList(scope.memory?.partitions, PROOF_PARTITIONS) ||
        !equal(scope.railway, { projects: [], environments: [] }) ||
        !equal(scope.workers, parseJson(root.scope).workers) || Object.hasOwn(scope, "proof") ||
        budget.usd_cents !== 0 || budget.deploys !== 0 || !integer(budget.calls, 1, Math.min(40, parseJson(root.budget).calls)) ||
        constraints.maxWorkers !== 0 || constraints.maxReplicas !== 1 || constraints.allowDelete !== false || constraints.requireDryRun !== true)
      return "proof_child_bounds_invalid";
    return null;
  } catch { return "proof_child_bounds_invalid"; }
}
