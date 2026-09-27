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
import { randomBytes } from "crypto";
import { getTenant, getSetting, setSetting, sql } from "./db.js";
import { nowSec, newId, parseJson, hmacSha256, HttpError } from "./util.js";
import { issueChildGrant, mintRootGrant } from "./grants.js";
import { TIERS, memoryPartitions, remainingBudget } from "./policy.js";
import { SERVICE_NAME, VERSION, GUEST_MAX_PER_HOUR, GUEST_FP_WINDOW_SEC, GUEST_FP_SALT_TTL_SEC, GUEST_POOL_MIN_SLOTS } from "./config.js";
import { TEMPLATES } from "./railway.js";

/**
 * The one worker template a guest may deploy — the free probe. ENFORCED at deploy
 * via the grant's scope.templates allow-list: deployWorker rejects any other
 * template with 403 template_not_allowed BEFORE any charge or plan-insert, and
 * attenuationViolations treats a parent's list as a ceiling (a child cannot widen
 * it or drop back to wildcard). Two independent backstops remain: the guest-pool
 * tenant's EMPTY project scope (no_target_project) and requireDryRun — so
 * probe-only no longer rests on empty scope alone.
 */
export var GUEST_TEMPLATE = "probe";

/** The tenant every guest grant is a child of. Its root grant is the pool. */
export var GUEST_POOL_TENANT = "guest-pool";
/** A large tier so the pool holds many guests; the per-guest envelope is TIERS.guest, applied to each child. */
export var GUEST_POOL_TIER = "house";
/**
 * What a guest may do. NOT grant.issue, code.write, cog.execute, or any paid
 * surface. The public directory needs no capability, so there is no directory
 * cap here — a guest reads the shopfront like anyone.
 *
 * ledger.read is RESTORED (step 4, 2026-09-27): /api/ledger and the ledger_query
 * MCP tool are now SUBTREE-scoped (rows for the caller's own grant + descendants),
 * and a pooled guest is a depth-1 leaf, so it reads only its own reserve/self-settle
 * rows — never a sibling guest's or the pool root's. That is a real "your own spend"
 * receipt, so a guest can spend and leave with one.
 */
export var GUEST_CAPS = ["grant.read", "cog.plan", "memory.write", "deploy.worker", "ledger.read"];

// Guest memory bounds (step 4). A guest write settles no budget and would fan a
// sync to the cognitive brain, so it gets a tighter write meter than the generic
// per-grant limit, a footprint cap over its own partition, AND is quarantined from
// the brain sync entirely (see writeMemory). Numbers are published in GUEST_POLICY.memory.
export var GUEST_MEMORY_WRITES_PER_MIN = 10;
export var GUEST_MAX_MEMORIES = 100;
export var GUEST_MEMORY_MAX_BYTES = 262144; // 256 KiB
/**
 * The guest write context, or null for every non-guest (so normal tenants are
 * untouched — uncapped and synced as before). A guest is exactly a depth-1 child
 * of the shared guest-pool tenant.
 */
export function guestWriteContext(auth) {
  if (!auth || auth.tenant?.id !== GUEST_POOL_TENANT) return null;
  return {
    grantId: auth.row.id,
    tenant: auth.tenant.id,
    base: memoryPartitions(parseJson(auth.row.scope))[0] || "",
    ratePerMin: GUEST_MEMORY_WRITES_PER_MIN,
    maxRows: GUEST_MAX_MEMORIES,
    maxBytes: GUEST_MEMORY_MAX_BYTES,
  };
}

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

// The guest envelope's budget — ONE source, read by both issueGuestGrant (below)
// and the pool breaker, so advertised capacity and the issued grant cannot drift.
export var GUEST_BUDGET = () => ({ usd_cents: TIERS.guest.usdCents, calls: TIERS.guest.deploysPerPeriod * 20, deploys: TIERS.guest.deploysPerPeriod });

/** Read-only: the active depth-0 pool root, or null. NEVER mints (safe for a public read path). */
export async function readGuestPool() {
  return (
    (await sql`SELECT * FROM grants WHERE tenant = ${GUEST_POOL_TENANT} AND depth = 0 AND status = 'active' AND exp > ${nowSec()} ORDER BY exp DESC LIMIT 1`)[0] || null
  );
}

/**
 * The pool's health in whole guest ENVELOPES (slots), the tightest budget
 * dimension governing. `open` is false below the floor. Pure — no mint, no write.
 */
export function guestPoolStatus(pool) {
  let rem = remainingBudget(pool),
    env = GUEST_BUDGET(),
    slots = Math.min(Math.floor(rem.usd_cents / env.usd_cents), Math.floor(rem.calls / env.calls), Math.floor(rem.deploys / env.deploys));
  return { open: slots > GUEST_POOL_MIN_SLOTS, remaining_slots: slots, floor_slots: GUEST_POOL_MIN_SLOTS, remaining: rem };
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
  // Circuit breaker: pause with a clean 503 before the pool hits the hard 402 wall
  // (soft; issueChildGrant's FOR UPDATE + budget recheck is still the transactional
  // floor). Resume is automatic — the next call recomputes remaining live once the
  // reaper releases expired reservations.
  let st = guestPoolStatus(pool);
  if (!st.open)
    throw new HttpError(503, "guest_pool_exhausted", { remaining_slots: st.remaining_slots, floor_slots: st.floor_slots, retry_after_sec: g.maxTtlSec });
  return issueChildGrant(
    pool,
    {
      sub: ("guest:" + (name || "anon") + ":" + key).slice(0, 80),
      caps: GUEST_CAPS,
      ttlSec: g.maxTtlSec,
      budget: GUEST_BUDGET(),
      constraints: { maxWorkers: g.maxWorkers, maxReplicas: g.maxReplicas, allowDelete: false, requireDryRun: true },
      scope: { memory: { partitions: ["guest/" + key] }, templates: [GUEST_TEMPLATE] },
    },
    "guest-welcome",
  );
}

// ── sybil defence (step 4) ────────────────────────────────────────────────────
// A per-visitor fingerprint gates the keyless mint: one active guest grant per
// fingerprint + GUEST_MAX_PER_HOUR mints per window. The fingerprint is
// HMAC(salt, clientIp) — only a 64-hex hash is stored, never a raw IP — and the
// salt self-rotates so old fingerprints become unlinkable. The route passes
// Railway's TRUSTED X-Real-IP (docs: Railway sets it as the client's remote IP);
// X-Forwarded-For is NOT trusted on Railway (client-appendable). This is a speed
// bump, not the breaker — the pool budget + reaper is the real economic limit.
async function currentSalt() {
  let row = (await sql`SELECT value, extract(epoch from updated_at)::bigint AS ts FROM settings WHERE key = 'guest_fp_salt'`)[0];
  if (row && row.value && nowSec() - Number(row.ts) < GUEST_FP_SALT_TTL_SEC) return row.value;
  let salt = randomBytes(32).toString("hex");
  await setSetting("guest_fp_salt", salt); // self-init + self-rotate; no cron, no index.js change
  return salt;
}
// IP ONLY. Folding agent_name in would let one IP mint unlimited grants by varying the name.
export async function guestFingerprint(ip) {
  return hmacSha256(await currentSalt(), String(ip || "noip"));
}
// ONE atomic upsert enforces BOTH invariants (one-active via grant_exp<=now, rate
// via count<max in-window); an empty RETURNING means denied, then one SELECT classifies.
async function claimGuestFingerprint(fp, predictedExp) {
  let now = nowSec(),
    win = Math.floor(now / GUEST_FP_WINDOW_SEC) * GUEST_FP_WINDOW_SEC,
    rows = await sql`
      INSERT INTO guest_fingerprints (fp, grant_id, grant_exp, window_start, count, updated_at)
      VALUES (${fp}, ${null}, ${predictedExp}, ${win}, 1, ${now})
      ON CONFLICT (fp) DO UPDATE SET
        count = CASE WHEN guest_fingerprints.window_start = ${win} THEN guest_fingerprints.count + 1 ELSE 1 END,
        window_start = ${win}, grant_exp = ${predictedExp}, updated_at = ${now}
      WHERE guest_fingerprints.grant_exp <= ${now}
        AND (guest_fingerprints.window_start <> ${win} OR guest_fingerprints.count < ${GUEST_MAX_PER_HOUR})
      RETURNING count`;
  if (Math.random() < 0.01)
    await sql`DELETE FROM guest_fingerprints WHERE grant_exp <= ${now} AND window_start < ${now - GUEST_FP_WINDOW_SEC}`;
  if (!rows.length) {
    let cur = (await sql`SELECT grant_exp FROM guest_fingerprints WHERE fp = ${fp}`)[0];
    if (cur && Number(cur.grant_exp) > now) throw new HttpError(409, "guest_grant_active");
    throw new HttpError(429, "guest_rate_limited");
  }
}
// The guarded entrypoint the route calls: fingerprint-gate, mint, then bind the
// real grant id/exp. A mint failure releases the active-lock (grant_exp=0) so a
// failed attempt can't lock a fingerprint for a window.
export async function issueGuestGrantGuarded({ ip = "noip", agentName = "", homeUrl = "" } = {}) {
  let fp = await guestFingerprint(ip),
    predictedExp = nowSec() + TIERS.guest.maxTtlSec;
  await claimGuestFingerprint(fp, predictedExp);
  try {
    let r = await issueGuestGrant({ agentName, homeUrl });
    await sql`UPDATE guest_fingerprints SET grant_id = ${r.row.id}, grant_exp = ${Number(r.row.exp)} WHERE fp = ${fp}`;
    return r;
  } catch (e) {
    // Release the optimistic hold this attempt took (claimGuestFingerprint set
    // grant_exp=predicted). We only reach here after claim confirmed there was NO
    // active grant, so clearing the lock and any stale grant_id is correct — a
    // failed mint (e.g. a transient pool_exhausted 503) must NOT lock the
    // fingerprint for a window. The old `WHERE grant_id IS NULL` never matched a
    // returning fingerprint, so it self-inflicted a ~1h 409 lockout (review 2026-09-27).
    await sql`UPDATE guest_fingerprints SET grant_exp = 0, grant_id = NULL WHERE fp = ${fp}`;
    throw e;
  }
}

/**
 * The published guest policy — ONE source of truth. The directory serves it as
 * the #rules section, and step 4's sybil enforcement reads the SAME constants,
 * so what is advertised and what is enforced can never drift (Law 5). Nothing
 * here is enforced until step 4; nothing is deployed until step 4 either.
 */
export var GUEST_POLICY = {
  issuance: { per_fingerprint_per_hour: GUEST_MAX_PER_HOUR, one_active_grant_per_fingerprint: true },
  memory: { writes_per_min: GUEST_MEMORY_WRITES_PER_MIN, max_memories: GUEST_MAX_MEMORIES, max_bytes: GUEST_MEMORY_MAX_BYTES, brain_sync: "quarantined" },
  guest_grant: {
    budget_usd_cents: TIERS.guest.usdCents,
    ttl_sec: TIERS.guest.maxTtlSec,
    caps: GUEST_CAPS,
    worker_template: GUEST_TEMPLATE,
    max_workers: TIERS.guest.maxWorkers,
  },
  acceptable_use:
    "A guest may look, plan, remember in its own scope, read its own ledger, and run the free probe. No paid templates, no grant issuance, no code execution until resident. One active guest grant per fingerprint; issuance is rate-limited.",
  graduation: { settle_calls: 10, becomes: "resident grant (higher budget, longer TTL, paid templates)" },
};

/**
 * The public capability shopfront. Every priced, deployable capability is a
 * worker TEMPLATE: name, description, price, the input contract (env keys the
 * caller must supply), whether a guest may run it, and REAL reliability derived
 * from the deploys table — never a fabricated number, and "no sample yet" until
 * a template has actually run.
 */
export async function directory(baseUrl) {
  let rows = await sql`SELECT template,
      count(*) FILTER (WHERE executed) AS runs,
      count(*) FILTER (WHERE executed AND status = 'failed') AS failed
    FROM deploys GROUP BY template`,
    stat = Object.fromEntries(rows.map((r) => [r.template, { runs: Number(r.runs), failed: Number(r.failed) }]));
  let capabilities = Object.entries(TEMPLATES).map(([name, t]) => {
    let s = stat[name] || { runs: 0, failed: 0 };
    return {
      name,
      kind: t.kind,
      description: t.desc,
      price: { usd_cents: t.estCents },
      input_contract: { requires: t.needs || [] },
      guest_allowed: name === GUEST_TEMPLATE,
      reliability: s.runs > 0 ? { runs: s.runs, failed: s.failed } : { runs: 0, note: "no sample yet" },
    };
  });
  return {
    service: SERVICE_NAME,
    version: VERSION,
    capabilities,
    guest: { grant_via: baseUrl + "/api/guest", ...GUEST_POLICY.guest_grant },
    rules: GUEST_POLICY,
    graduation: GUEST_POLICY.graduation,
  };
}

/** The welcome package: everything an agent needs to start doing business, machine-readable, in one shot. */
export function welcomePackage(row, token, baseUrl) {
  let b = parseJson(row.budget);
  return {
    grant: token,
    budget: { total: b.usd_cents, unit: "usdCents", renews_in_sec: Math.max(0, Number(row.exp) - nowSec()) },
    directory: baseUrl + "/directory",
    house_rules: baseUrl + "/directory#rules",
    ledger: baseUrl + "/api/ledger — your own subtree receipt; GET with this grant",
    graduation: "settle 10 successful calls → resident grant (higher budget, longer TTL)",
  };
}
