import test from "node:test";
import assert from "node:assert/strict";
import {
  PROOF_CAPS, PROOF_PROFILE, PROOF_REDIRECT, PROOF_RUNTIME, PROOF_ROOT_SUB, PROOF_SUB,
  isProofRedirect, proofConfig, proofProfileForRedirect, validateRootGrantBody,
  validateProofRootLimits, proofRootProblem, proofChildProblem, rejectProofOAuthOverrides,
} from "../src/proof-oauth.js";

const env = { PUBLIC_URL: PROOF_RUNTIME, DEVDESK_PROOF_ENABLED: "1",
  DEVDESK_PROOF_TENANT: "t_fixture", DEVDESK_PROOF_REDIRECT_URI: PROOF_REDIRECT };
const tenant = { id: "t_fixture", tier: "starter", status: "active" };
const tier = { maxTtlSec: 3600 };
const limits = () => ({ caps: [...PROOF_CAPS], scope: { memory: { partitions: ["product:devdesk"] } },
  budget: { usd_cents: 0, calls: 40, deploys: 0 }, ttlSec: 14400 });
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code);
const sealFixture = (row) => ({ ...row, payload: JSON.stringify(row) });
function rootFixture() {
  const p = validateProofRootLimits(limits(), tenant, tier, env);
  return sealFixture({ id: "gr_root", tenant: tenant.id, parent: null, depth: 0, sub: PROOF_ROOT_SUB,
    status: "active", exp: 20000, caps: p.caps, budget: p.budget, constraints: p.constraints,
    scope: { railway: { projects: [], environments: [] }, workers: { namePrefix: "t-test-" },
      memory: p.memory, proof: p.marker } });
}
function childFixture(root) {
  return sealFixture({ id: "gr_child", tenant: tenant.id, parent: root.id, depth: 1, sub: PROOF_SUB,
    status: "active", exp: 12000, caps: [...PROOF_CAPS], budget: { usd_cents: 0, calls: 40, deploys: 0 },
    constraints: { maxWorkers: 0, maxReplicas: 1, allowDelete: false, requireDryRun: true, autonomy: "ask" },
    scope: { railway: { projects: [], environments: [] }, workers: root.scope.workers,
      memory: { partitions: ["product:devdesk"] } } });
}

test("proof requires exact enabled staging configuration", () => {
  assert.deepEqual(proofConfig(env), { tenant: tenant.id });
  for (const enabled of [undefined, "", "true", "0"]) rejects(() => proofConfig({ ...env, DEVDESK_PROOF_ENABLED: enabled }), "proof_disabled");
  for (const publicUrl of [undefined, "https://runtime.meshtool.ai", PROOF_RUNTIME + "/"])
    rejects(() => proofConfig({ ...env, PUBLIC_URL: publicUrl }), "proof_configuration_invalid");
  rejects(() => proofConfig({ ...env, DEVDESK_PROOF_TENANT: "" }), "proof_configuration_invalid");
});

test("reserved proof family cannot fall through when disabled or near-miss", () => {
  assert.equal(proofProfileForRedirect(PROOF_REDIRECT, env), PROOF_PROFILE);
  for (const uri of [PROOF_REDIRECT + "?x=1", PROOF_REDIRECT + "/", PROOF_REDIRECT.replace("https:", "http:"),
      PROOF_REDIRECT.replace("/runtime/callback", "/other"), PROOF_REDIRECT.replace(".ai/", ".ai:8443/")]) {
    assert.equal(isProofRedirect(uri), true);
    rejects(() => proofProfileForRedirect(uri, env), "proof_redirect_mismatch");
  }
  rejects(() => proofProfileForRedirect(PROOF_REDIRECT, { ...env, DEVDESK_PROOF_ENABLED: "0" }), "proof_disabled");
  assert.equal(isProofRedirect("https://claude.ai/oauth/callback"), false);
});

test("root request fields must be explicit and never silently ignored", () => {
  validateRootGrantBody({});
  validateRootGrantBody({ sub: "tenant:root" });
  validateRootGrantBody({ sub: PROOF_ROOT_SUB, proof_limits: limits() });
  for (const key of ["caps", "scope", "budget", "ttlSec", "limits"])
    rejects(() => validateRootGrantBody({ [key]: {} }), "root_grant_parameter_not_supported");
  rejects(() => validateRootGrantBody({ sub: PROOF_ROOT_SUB }), "proof_limits_required");
  rejects(() => validateRootGrantBody({ sub: "agent:operator", proof_limits: limits() }), "proof_root_subject_required");
});

test("bounded root preserves explicit zero money and deployment budgets", () => {
  const p = validateProofRootLimits(limits(), tenant, tier, env);
  assert.deepEqual(p.caps, PROOF_CAPS);
  assert.deepEqual(p.budget, { usd_cents: 0, calls: 40, deploys: 0 });
  assert.equal(p.ttlSec, 14400);
  assert.deepEqual(p.memory, { partitions: ["product:devdesk"] });
  assert.equal(p.constraints.allowDelete, false);
  assert.equal(p.constraints.maxWorkers, 0);
});

test("bounded root rejects caps, scope and tenant widening", () => {
  for (const caps of [[...PROOF_CAPS, "grant.issue"], [...PROOF_CAPS, "deploy.worker"], PROOF_CAPS.slice(1), [...PROOF_CAPS, PROOF_CAPS[0]]])
    rejects(() => validateProofRootLimits({ ...limits(), caps }, tenant, tier, env), "proof_caps_invalid");
  for (const partition of ["", "agent:", "product:", "product:devdesktop"])
    rejects(() => validateProofRootLimits({ ...limits(), scope: { memory: { partitions: [partition] } } }, tenant, tier, env), "proof_scope_invalid");
  rejects(() => validateProofRootLimits(limits(), { ...tenant, id: "t_other" }, tier, env), "proof_tenant_mismatch");
  rejects(() => validateProofRootLimits(limits(), { ...tenant, status: "suspended" }, tier, env), "proof_tenant_mismatch");
});

test("malformed bounds and unknown nested fields fail before issuance", () => {
  for (const calls of [0, 41, -1, 1.5, "40", NaN, Infinity, null])
    rejects(() => validateProofRootLimits({ ...limits(), budget: { usd_cents: 0, calls, deploys: 0 } }, tenant, tier, env), "proof_budget_invalid");
  for (const budget of [{ usd_cents: 1, calls: 40, deploys: 0 }, { usd_cents: 0, calls: 40, deploys: 1 },
      { usd_cents: 0, calls: 40, deploys: 0, extra: true }])
    rejects(() => validateProofRootLimits({ ...limits(), budget }, tenant, tier, env), "proof_budget_invalid");
  for (const ttlSec of [0, 59, 14401, "3600", 60.5, NaN])
    rejects(() => validateProofRootLimits({ ...limits(), ttlSec }, tenant, tier, env), "proof_ttl_invalid");
  rejects(() => validateProofRootLimits({ ...limits(), ignored: true }, tenant, tier, env), "proof_limits_invalid");
});

test("roots require signed immutable bounds and remain expired or revoked", () => {
  const root = rootFixture();
  assert.equal(proofRootProblem(root, env, 10000), null);
  assert.equal(proofRootProblem({ ...root, status: "revoked" }, env, 10000), "proof_root_inactive");
  assert.equal(proofRootProblem(root, env, 20000), "proof_root_inactive");
  assert.equal(proofRootProblem({ ...root, budget: { usd_cents: 0, calls: 100, deploys: 0 } }, env, 10000), "proof_root_inactive");
  const broad = structuredClone(root); broad.caps.push("deploy.worker"); broad.payload = JSON.stringify(broad);
  assert.equal(proofRootProblem(broad, env, 10000), "proof_root_bounds_invalid");
});

test("child lease cannot widen, outlive or revive its parent", () => {
  const root = rootFixture(), child = childFixture(root);
  assert.equal(proofChildProblem(child, root, tenant, env, 10000), null);
  assert.equal(proofChildProblem(child, root, tenant, env, 12000), "proof_child_inactive");
  assert.equal(proofChildProblem({ ...child, status: "revoked" }, root, tenant, env, 10000), "proof_child_inactive");
  assert.equal(proofChildProblem(child, { ...root, status: "revoked" }, tenant, env, 10000), "proof_root_inactive");
  assert.equal(proofChildProblem(child, root, { ...tenant, status: "suspended" }, env, 10000), "proof_child_inactive");
});

test("proof OAuth rejects override-looking inputs instead of ignoring them", () => {
  rejectProofOAuthOverrides({ client_id: "oc_fixture", redirect_uri: PROOF_REDIRECT, tenant: tenant.id });
  for (const key of ["caps", "budget", "scope", "profile", "root_id", "root_limits", "proof_limits", "resource"])
    rejects(() => rejectProofOAuthOverrides({ [key]: {} }), "proof_parameter_not_supported");
});
