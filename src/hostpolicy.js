// Agent-host rules (docs/specs/agent-host.md) — dependency-free, so they are unit-tested
// with bare `bun test`. The DB side (hire checks, the host tree) is in grants.js and
// routes/grants.js.
//
// An agent-host is a grant the OWNER mints (root → host, depth 1) that an agent runs
// under and hires sub-agents from. Every hire is a child grant of the host, so it is
// already capped by the host's budget, caps, depth and dial. On top of that a host
// carries hard ceilings in constraints.host:
//   maxSubagents  — live (active, unexpired) grants below the host at once
//   maxDepthBelow — how many levels a hire may sit below the host
// and every hire is named agent:<host-id>/<role> so the ledger traces it to its host.

// Owner decisions (recommended defaults, 2026-09-28).
export const HOST_TIERS = ["pro", "studio", "house"];
export const HOST_DEFAULTS = { maxSubagents: 10, maxDepthBelow: 2, autonomy: "ask" };
export const HOST_BOUNDS = { maxSubagents: [1, 50], maxDepthBelow: [1, 3] };
// What a host holds unless the owner says otherwise — enough to hire, plan, remember
// and read its own books. Intersected with the owner's caps, so it can never widen.
export const HOST_DEFAULT_CAPS = [
  "grant.issue",
  "grant.read",
  "ledger.read",
  "cog.plan",
  "memory.read",
  "memory.write",
  "worker.status",
];
export const HOST_DEFAULT_BUDGET = { usd_cents: 500, calls: 100, deploys: 1 };

const clampInt = (v, [lo, hi], dflt) => {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

// The ceilings a new host gets. Null means a value was supplied but is not an integer.
export function hostLimits(body = {}) {
  const maxSubagents = clampInt(body.maxSubagents, HOST_BOUNDS.maxSubagents, HOST_DEFAULTS.maxSubagents);
  const maxDepthBelow = clampInt(body.maxDepthBelow, HOST_BOUNDS.maxDepthBelow, HOST_DEFAULTS.maxDepthBelow);
  if (maxSubagents === null || maxDepthBelow === null) return null;
  return { maxSubagents, maxDepthBelow };
}

// A host name is part of its sub (host:<name>) and of every hire's sub.
export function hostName(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(s) ? s : null;
}

// The sub a hire gets: agent:<host-id>/<role>. The role is whatever the host asked
// for, minus any agent: prefix and anything that would break the naming.
export function hireSub(hostId, requested) {
  const role =
    String(requested ?? "")
      .replace(/^agent:/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sub";
  return `agent:${hostId}/${role}`.slice(0, 80);
}

// The ceiling a proposed hire would break, or null. `hostDepth` is the host grant's
// depth, `childDepth` the new grant's, `liveBelow` the host's live descendants now.
export function hireViolation(limits, { hostDepth, childDepth, liveBelow }) {
  if (!limits) return null;
  if (childDepth - hostDepth > limits.maxDepthBelow) return "host_depth_exceeded";
  if (liveBelow >= limits.maxSubagents) return "host_subagents_exceeded";
  return null;
}
