// Agent identity: every agent grant answers to a seat, every seat answers to a human.
//
// The grant engine already makes power temporary (TTL, budget, attenuation, revoke-the-tree).
// This module adds the other half: WHO the agent is and WHO is on the hook for it.
//
//   blueprints  a family of agents (e.g. "cline-worker", "frank"). Freeze it and every agent
//               built from it stops at the door at once. Reversible: unfreeze and they're back.
//   agents      one row per (tenant, sub) — the seat. sponsor (the human accountable for WHY it
//               exists), owner (who keeps it running), purpose, blueprint, expiry, and an
//               ATTESTATION that decays: the sponsor has to re-up it every N days or the seat
//               lapses. Access can't outlive the sponsor's attention.
//
// What this does beyond "one ID per agent + blueprint kill switch":
//   1. Lineage freeze  A freeze applies to the frozen agent AND everything it delegated to.
//                      verifyGrant walks the grant chain upward; a frozen seat or blueprint
//                      anywhere above a key stops that key. Delegation can't launder a freeze.
//   2. Decaying attestation  A dead-man's switch on every seat (see attest_every_days).
//   3. Self-quarantine  An agent that keeps getting denied for reaching past its power
//                      (missing_cap / out_of_scope) freezes itself after N strikes in a
//                      10-minute window — no human has to notice first.
//   4. Blast-radius preview  Every freeze can be dry-run first and always answers with exactly
//                      which seats and how many live keys it stops; the real freeze writes
//                      those numbers into the event log as its receipt.
//
// Safety rails:
//   - Root grants (depth 0) are the human owner's credential and are never checked here.
//   - FREEZES are always enforced, in every mode. Only the paperwork (unseated / no sponsor /
//     expired / attestation lapsed) follows the mode:
//       off      paperwork ignored
//       warn     (default) paperwork problems are logged as identity.warn events, call allowed
//       enforce  paperwork problems answer 403 identity_required
//     Ship in warn, backfill seats, watch identity.warn go quiet, then flip to enforce.
import { getSetting, recordEvent, setSetting, sql } from "./db.js";
import { HttpError } from "./util.js";

export var IDENTITY_MODES = ["off", "warn", "enforce"];
export var DEFAULT_IDENTITY_MODE = "warn";
var STRIKE_WINDOW_SEC = 600;
var DEFAULT_STRIKES = 5;
var MAX_CHAIN = 32;
// warn events are deduped per (tenant, sub, reason) so a busy agent logs one line, not one per call.
var WARN_EVERY_MS = 10 * 60 * 1000;
var lastWarn = new Map();

export async function identityMode() {
  let m = await getSetting("identity_mode");
  return IDENTITY_MODES.includes(m) ? m : DEFAULT_IDENTITY_MODE;
}
export async function setIdentityMode(m) {
  if (!IDENTITY_MODES.includes(m)) throw new HttpError(400, "bad_mode", { allowed: IDENTITY_MODES });
  await setSetting("identity_mode", m);
  return m;
}
export async function strikeLimit() {
  let n = Number(await getSetting("identity_strikes"));
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STRIKES;
}

// The seat for this grant and every grant above it, nearest first (lvl 0 = the grant itself).
async function chainSeats(q, grantId) {
  return q`
    WITH RECURSIVE up AS (
      SELECT id, parent, sub, tenant, 0 AS lvl FROM grants WHERE id = ${grantId}
      UNION ALL
      SELECT g.id, g.parent, g.sub, g.tenant, up.lvl + 1 FROM grants g JOIN up ON g.id = up.parent WHERE up.lvl < ${MAX_CHAIN}
    )
    SELECT up.lvl, up.id AS grant_id, up.sub, a.sub AS seat, a.status AS a_status, a.frozen_reason AS a_reason,
           a.sponsor, a.expires_at, a.attested_at, a.attest_every_days, a.blueprint,
           b.status AS b_status, b.frozen_reason AS b_reason
    FROM up
    LEFT JOIN agents a ON a.tenant = up.tenant AND a.sub = up.sub
    LEFT JOIN blueprints b ON b.tenant = a.tenant AND b.id = a.blueprint
    ORDER BY up.lvl`;
}

// What, if anything, is wrong with the paperwork on this seat. null = in order.
export function paperworkProblem(seat, nowMs = Date.now()) {
  if (!seat?.seat) return "unseated";
  if (!seat.sponsor) return "no_sponsor";
  if (seat.expires_at && new Date(seat.expires_at).getTime() <= nowMs) return "agent_expired";
  let every = Number(seat.attest_every_days) || 0;
  if (every > 0) {
    let at = seat.attested_at ? new Date(seat.attested_at).getTime() : 0;
    if (at + every * 86400000 <= nowMs) return "attestation_lapsed";
  }
  return null;
}

// Called by verifyGrant for every agent key, after the grant itself is known to be live.
export async function checkIdentity(row) {
  if (!row || Number(row.depth) === 0) return { mode: "root" };
  let chain = await chainSeats(sql, row.id);
  // 1. freezes: always enforced, anywhere in the lineage
  for (let c of chain) {
    if (c.b_status === "frozen")
      throw new HttpError(403, "blueprint_frozen", { blueprint: c.blueprint, sub: c.sub, at: c.lvl === 0 ? "self" : "above", reason: c.b_reason || void 0 });
    if (c.a_status === "frozen" || c.a_status === "quarantined")
      throw new HttpError(403, c.a_status === "quarantined" ? "agent_quarantined" : "agent_frozen", { sub: c.sub, at: c.lvl === 0 ? "self" : "above", reason: c.a_reason || void 0 });
  }
  // 2. paperwork on the seat this key belongs to
  let mode = await identityMode();
  if (mode === "off") return { mode };
  let problem = paperworkProblem(chain[0]);
  if (!problem) return { mode };
  if (mode === "enforce") throw new HttpError(403, "identity_required", { reason: problem, sub: row.sub });
  let k = `${row.tenant}|${row.sub}|${problem}`,
    now = Date.now();
  if ((lastWarn.get(k) || 0) + WARN_EVERY_MS <= now) {
    lastWarn.set(k, now);
    if (lastWarn.size > 5000) lastWarn.clear();
    await recordEvent("identity.warn", { sub: row.sub, reason: problem, grant: row.id }, row.tenant, row.sub);
  }
  return { mode, warn: problem };
}

// A denial for reaching past its power. Registered, active agents only; root grants never.
export async function recordStrike(row, why) {
  if (!row || Number(row.depth) === 0) return null;
  let w = Math.floor(Date.now() / 1000 / STRIKE_WINDOW_SEC);
  let r = (
    await sql`UPDATE agents
      SET strikes = CASE WHEN strikes_window_start = ${w} THEN strikes + 1 ELSE 1 END, strikes_window_start = ${w}, updated_at = now()
      WHERE tenant = ${row.tenant} AND sub = ${row.sub} AND status = 'active' RETURNING strikes`
  )[0];
  if (!r) return null;
  let limit = await strikeLimit();
  if (Number(r.strikes) < limit) return { strikes: Number(r.strikes), limit };
  let reason = `auto: ${r.strikes} denied calls (${why}) within ${STRIKE_WINDOW_SEC / 60} min`;
  let q = (
    await sql`UPDATE agents SET status = 'quarantined', frozen_reason = ${reason}, updated_at = now()
      WHERE tenant = ${row.tenant} AND sub = ${row.sub} AND status = 'active' RETURNING sub`
  )[0];
  if (q) await recordEvent("identity.quarantined", { sub: row.sub, reason, grant: row.id }, row.tenant, "runtime");
  return { strikes: Number(r.strikes), limit, quarantined: !!q };
}

// Exactly what a freeze stops: the seats, and every live key at or below a grant held by one of them.
export async function blastRadius(tenant, subs) {
  if (!subs.length) return { seats: [], liveKeys: 0, sample: [] };
  let keys = await sql`
    WITH RECURSIVE down AS (
      SELECT id FROM grants WHERE tenant = ${tenant} AND sub IN (SELECT jsonb_array_elements_text(${subs}::jsonb)) AND status = 'active'
      UNION
      SELECT g.id FROM grants g JOIN down ON g.parent = down.id WHERE g.status = 'active'
    )
    SELECT g.id, g.sub FROM grants g JOIN down ON g.id = down.id
    WHERE g.exp > ${Math.floor(Date.now() / 1000)} ORDER BY g.id`;
  return { seats: subs, liveKeys: keys.length, sample: keys.slice(0, 20).map((k) => ({ id: k.id, sub: k.sub })) };
}

// Grants that are live right now with no seat behind them: the backfill to-do list.
export async function unseatedAgents(limit = 200) {
  return sql`
    SELECT g.tenant, g.sub, count(*)::int AS live_keys, max(g.exp) AS latest_exp
    FROM grants g LEFT JOIN agents a ON a.tenant = g.tenant AND a.sub = g.sub
    WHERE g.depth > 0 AND g.status = 'active' AND g.exp > ${Math.floor(Date.now() / 1000)} AND a.sub IS NULL
    GROUP BY g.tenant, g.sub ORDER BY live_keys DESC, g.sub LIMIT ${limit}`;
}
