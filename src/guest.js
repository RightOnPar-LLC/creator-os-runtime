// Guest onboarding — the keyless front door (guest-welcome Phase 1, step 2).
//
// A visitor with no prior identity calls POST /api/guest and gets a working,
// attenuated grant plus the machine-readable welcome package in ONE response —
// zero human help, no docs archaeology. Everything a guest may do (look, plan,
// remember in its own scope, read its own ledger, run the free probe) is a cap
// on that grant; everything it may not (issue grants, write code, execute, paid
// work) is simply absent, so every over-reach fails closed at the gate it hits.
//
// The guest grant descends from a shared house guest POOL: a normal tenant on a
// large tier whose root grant's remaining budget IS the pool. issueChildGrant
// reserves each guest's budget against that remaining and 402s when it is dry —
// so the pool is a real economic circuit breaker even before step 4 adds the
// explicit threshold, per-fingerprint dedupe and rate limit. Each guest is
// capped to the guest ENVELOPE (TIERS.guest: 500 usdCents, 3600s, one worker,
// depth 1), not the pool tenant's tier — the deploy path binds the grant's own
// constraints and budget, only deploysPerPeriod reads the tenant tier.
import { getTenant, sql } from "./db.js";
import { nowSec, newId, parseJson } from "./util.js";
import { issueChildGrant, mintRootGrant } from "./grants.js";
import { TIERS } from "./policy.js";

/** The tenant every guest grant is a child of. Its root grant is the pool. */
export var GUEST_POOL_TENANT = "guest-pool";
/** A large tier so the pool holds many guests; the per-guest envelope is TIERS.guest, applied to each child. */
export var GUEST_POOL_TIER = "house";
/**
 * What a guest may do. NOT grant.issue, code.write, cog.execute, or any paid
 * surface. The public directory needs no capability, so there is no directory
 * cap here — a guest reads the shopfront like anyone.
 */
export var GUEST_CAPS = ["grant.read", "cog.plan", "memory.write", "ledger.read", "deploy.worker"];

/** Ensure the guest-pool tenant and an active, funded root grant exist; return the root grant row. */
export async function ensureGuestPool() {
  let t = await getTenant(GUEST_POOL_TENANT);
  if (!t) {
    await sql`INSERT INTO tenants (id, name, tier, allowed_targets)
      VALUES (${GUEST_POOL_TENANT}, ${"House Guest Pool"}, ${GUEST_POOL_TIER}, ${{}}::jsonb)
      ON CONFLICT (id) DO NOTHING`;
    t = await getTenant(GUEST_POOL_TENANT);
  }
  // The OAuth root pattern: reuse an active depth-0 grant with real headroom, else mint one.
  let r = (
    await sql`SELECT * FROM grants WHERE tenant = ${GUEST_POOL_TENANT} AND depth = 0 AND status = 'active' AND exp > ${nowSec() + 3600} ORDER BY exp DESC LIMIT 1`
  )[0];
  return r || (await mintRootGrant(t)).row;
}

/**
 * Mint a guest grant. `agentName` and `homeUrl` are optional visitor hints;
 * homeUrl is accepted now for API stability and used by the step-4 fingerprint,
 * so it is sanitised but not yet load-bearing. Memory is isolated per guest via
 * a unique partition, so one guest can never read another's writes.
 */
export async function issueGuestGrant({ agentName = "", homeUrl = "" } = {}) {
  let pool = await ensureGuestPool(),
    g = TIERS.guest,
    key = newId("guest"),
    name = String(agentName || "").replace(/[^\w .:-]/g, "").slice(0, 60),
    // homeUrl: accepted, sanitised, reserved for step-4 sybil fingerprinting.
    _home = String(homeUrl || "").replace(/[^\w.:/?=&%-]/g, "").slice(0, 200);
  return issueChildGrant(
    pool,
    {
      sub: ("guest:" + (name || "anon") + ":" + key).slice(0, 80),
      caps: GUEST_CAPS,
      ttlSec: g.maxTtlSec,
      budget: { usd_cents: g.usdCents, calls: g.deploysPerPeriod * 20, deploys: g.deploysPerPeriod },
      constraints: { maxWorkers: g.maxWorkers, maxReplicas: g.maxReplicas, allowDelete: false, requireDryRun: true },
      scope: { memory: { partitions: ["guest/" + key] } },
    },
    "guest-welcome",
  );
}

/** The welcome package: everything an agent needs to start doing business, machine-readable, in one shot. */
export function welcomePackage(row, token, baseUrl) {
  let b = parseJson(row.budget);
  return {
    grant: token,
    budget: { total: b.usd_cents, unit: "usdCents", renews_in_sec: Math.max(0, Number(row.exp) - nowSec()) },
    directory: baseUrl + "/directory",
    house_rules: baseUrl + "/directory#rules",
    ledger: "query your own spend via ledger_query, or GET /api/ledger with this grant",
    graduation: "settle 10 successful calls → resident grant (higher budget, longer TTL)",
  };
}
