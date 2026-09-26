// Caps, tiers, usage arithmetic, attenuation rules and the gatehouse.
import { nowSec, parseJson, sha256Hex } from "./util.js";
import { TEMPLATES } from "./railway.js";

export var CAPS = [
  "grant.issue",
  "grant.read",
  "cog.plan",
  "cog.execute",
  "deploy.worker",
  "worker.status",
  "worker.logs.read",
  "worker.restart",
  "worker.delete",
  "ledger.read",
  "tenant.read",
  "webhook.emit",
  "memory.read",
  "memory.write",
  "store.clips.read",
  "store.clips.link",
  "store.clips.edit",
  "store.clips.price",
  "store.ingest",
  "store.clips.publish",
];
var CAP_SET = new Set(CAPS);
export var TIERS = {
  starter: {
    maxWorkers: 2,
    deploysPerPeriod: 20,
    usdCents: 500,
    maxTtlSec: 3600,
    maxDepth: 2,
    maxReplicas: 1,
  },
  pro: {
    maxWorkers: 10,
    deploysPerPeriod: 200,
    usdCents: 5000,
    maxTtlSec: 86400,
    maxDepth: 3,
    maxReplicas: 2,
  },
  studio: {
    maxWorkers: 40,
    deploysPerPeriod: 1000,
    usdCents: 25000,
    maxTtlSec: 604800,
    maxDepth: 4,
    maxReplicas: 3,
  },
  house: {
    maxWorkers: 500,
    deploysPerPeriod: 1e5,
    usdCents: 1e7,
    maxTtlSec: 2592000,
    maxDepth: 6,
    maxReplicas: 5,
  },
};
export var zeroUsage = () => ({
  usd_cents: 0,
  calls: 0,
  deploys: 0,
});
export var normalizeUsage = (e) => ({
  usd_cents: Math.max(0, Math.floor(+e?.usd_cents || 0)),
  calls: Math.max(0, Math.floor(+e?.calls || 0)),
  deploys: Math.max(0, Math.floor(+e?.deploys || 0)),
});
export var subtractUsage = (e, t) => ({
  usd_cents: e.usd_cents - t.usd_cents,
  calls: e.calls - t.calls,
  deploys: e.deploys - t.deploys,
});
export var addUsage = (e, t) => ({
  usd_cents: e.usd_cents + t.usd_cents,
  calls: e.calls + t.calls,
  deploys: e.deploys + t.deploys,
});
export var usageWithin = (e, t) => e.usd_cents <= t.usd_cents && e.calls <= t.calls && e.deploys <= t.deploys;
export var remainingBudget = (e) =>
  subtractUsage(
    subtractUsage(normalizeUsage(parseJson(e.budget)), normalizeUsage(parseJson(e.reserved))),
    normalizeUsage(parseJson(e.settled)),
  );
export var memoryPartitions = (e) => e.memory?.partitions ?? [""];
// A scope prefix covers a partition only at a real boundary: exact match, the
// empty prefix (root wildcard), a prefix that already ends in a separator, or
// a candidate whose next character after the prefix IS a separator. A bare
// `.startsWith()` let a grant scoped to "worker:a" reach "worker:ab" (and a
// profile scoped to "product:devdesk" reach "product:devdesktop") — a
// different tenant/worker/product with no separator between them (2026-09-25 fix).
export function partitionCovers(prefix, candidate) {
  if (prefix === "" || candidate === prefix) return !0;
  if (!candidate.startsWith(prefix)) return !1;
  if (/[:/-]$/.test(prefix)) return !0;
  return /^[:/-]/.test(candidate.slice(prefix.length));
}
var numberOr = (e, t) => (e === void 0 || e === null || e === "" || Number.isNaN(+e) ? t : +e);
export var clampConstraints = (e, t) => ({
  maxWorkers: Math.min(t.maxWorkers, Math.max(0, Math.floor(numberOr(e?.maxWorkers, t.maxWorkers)))),
  maxReplicas: Math.min(t.maxReplicas, Math.max(1, Math.floor(numberOr(e?.maxReplicas, t.maxReplicas)))),
  allowDelete: t.allowDelete && e?.allowDelete === !0,
  requireDryRun: e?.requireDryRun === !1 ? t.requireDryRun && !1 : !0,
});
var isSubset = (e, t) => (e || []).every((a) => (t || []).includes(a));
export function attenuationViolations(e, t, a) {
  let n = [];
  try {
    let r = TIERS[a];
    if (!r) return ["unknown_tier"];
    let s = parseJson(e.caps),
      i = parseJson(e.scope),
      o = parseJson(e.constraints);
    for (let c of t.caps)
      if (!CAP_SET.has(c)) n.push(`unknown_cap:${c}`);
      else if (!s.includes(c)) n.push(`cap_not_in_parent:${c}`);
    if (t.caps.length === 0) n.push("no_caps");
    if (t.exp > Number(e.exp)) n.push("exp_exceeds_parent");
    if (t.exp - nowSec() > r.maxTtlSec) n.push("ttl_exceeds_tier");
    if (t.exp <= nowSec()) n.push("already_expired");
    if (!isSubset(t.scope.railway?.projects, i.railway?.projects)) n.push("scope_projects_widened");
    if (!isSubset(t.scope.railway?.environments, i.railway?.environments))
      n.push("scope_environments_widened");
    let l = i.workers?.namePrefix || "";
    if (!(t.scope.workers?.namePrefix || "").startsWith(l)) n.push("scope_prefix_widened");
    if (!memoryPartitions(t.scope).every((c) => memoryPartitions(i).some((E) => partitionCovers(E, c))))
      n.push("scope_memory_widened");
    if (!usageWithin(t.budget, remainingBudget(e))) n.push("budget_exceeds_parent_remaining");
    if (t.constraints.maxWorkers > o.maxWorkers) n.push("maxWorkers_widened");
    if (t.constraints.maxReplicas > o.maxReplicas) n.push("maxReplicas_widened");
    if (t.constraints.allowDelete && !o.allowDelete) n.push("allowDelete_widened");
    if (t.constraints.requireDryRun === !1 && o.requireDryRun) n.push("requireDryRun_loosened");
    if (t.depth !== Number(e.depth) + 1) n.push("bad_depth");
    if (t.depth > r.maxDepth) n.push("depth_exceeds_tier");
    if (e.status !== "active") n.push("parent_not_active");
    if (Number(e.exp) <= nowSec()) n.push("parent_expired");
  } catch (r) {
    n.push("policy_evaluation_error");
  }
  return n;
}
export function gatehouseEvaluate(e, t, a) {
  let n = [];
  try {
    if (!e || e.status !== "active") n.push("tenant_not_active");
    let r = TIERS[e?.tier];
    if (!r) n.push("unknown_tier");
    let s = Array.isArray(a?.grants) ? a.grants : null,
      i = Array.isArray(a?.deploys) ? a.deploys : null;
    if (!s || !i) n.push("malformed_proposal");
    if (s && s.length > 8) n.push("too_many_grants");
    if (i && i.length > 8) n.push("too_many_deploys");
    let o = parseJson(e?.allowed_targets || {});
    for (let l of s || []) {
      for (let c of l.caps || []) if (!CAP_SET.has(c)) n.push(`unknown_cap:${c}`);
      if (/money|wallet|trade|secret/i.test(JSON.stringify(l.caps || []))) n.push("forbidden_cap_family");
      if (+l.ttlSec > (r?.maxTtlSec ?? 0)) n.push("ttl_exceeds_tier");
      if (normalizeUsage(l.budget).usd_cents > (r?.usdCents ?? 0)) n.push("budget_exceeds_tier");
      for (let c of l.scope?.railway?.projects || [])
        if (!(o.railway?.projects || []).includes(c)) n.push(`target_not_allowed:${c}`);
    }
    for (let l of i || []) {
      if (!l.name || !/^[a-z0-9-]{3,48}$/.test(l.name)) n.push("bad_worker_name");
      if (l.name && !l.name.startsWith(tenantWorkerPrefix(String(e?.id || ""))))
        n.push("worker_name_missing_tenant_prefix");
      if ((+l.replicas || 1) > (r?.maxReplicas ?? 1)) n.push("replicas_exceed_tier");
      if (!l.template || !TEMPLATES[l.template]) n.push(`unknown_template:${l.template}`);
    }
    if (t && t.status !== "active") n.push("caller_grant_not_active");
  } catch {
    n.push("policy_evaluation_error");
  }
  return {
    ok: n.length === 0,
    reasons: n,
  };
}
export function tenantWorkerPrefix(e) {
  return `t-${sha256Hex(e).slice(0, 6)}-`;
}
