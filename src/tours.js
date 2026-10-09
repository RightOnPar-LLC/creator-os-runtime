// Tours (docs/specs/tours.md). More TIME for an agent without a long-lived key.
//
// The owner's rule is that a key an agent holds lives 24 hours at most (policy.js). A long
// key is what makes long work unsafe: stolen, it works for weeks and nobody has to look at
// it. A tour keeps every key short and makes the STAY long instead:
//
//   - A tour is a RECORD here (a row in `tours` plus a holding grant) that says: the agent
//     named <agent> may keep getting a fresh 24-hour key until <until>, inside this fixed
//     budget and these powers. Only the tenant's root key (the owner) can open one.
//   - The holding grant is not a credential. Its token is never handed out, and
//     verifyGrant refuses it by its `scope.tour.holder` mark even if one ever were.
//   - Each day's key is an ordinary child of the holding grant, so everything that is
//     already true of a key stays true: capped at 24 hours, never wider than its parent,
//     never outliving it, cancelled with it, its unspent budget returned on cancel.
//   - To carry on, the agent RENEWS with its current key. Renewal cancels that key and
//     issues the next one. The budget is the tour's, set once: time never refills money.
//   - If a key that a renewal already replaced is used again (later than a short grace
//     for calls that were in flight), somebody else has a copy. The tour FREEZES, every
//     key under it is cancelled, and it stays frozen until the owner reissues or ends it.
//   - Miss a renewal and the key simply runs out. Only the owner can reissue.
//
// ONE RULE HOLDS THIS FILE TOGETHER: a tour's keys are "every active grant directly under
// its holding grant", found by PARENT. `tours.current_key` is only a note of which one the
// tour handed out last. Anything that must stop the agent, or must be sure only one key
// lives, goes by parent, never by that note; so a step that fails half way (a cancel that
// throws, a process that dies between two statements) cannot leave a key working that the
// tour has lost sight of. The next issue, freeze or end sweeps it up.
//
// Nothing here is a new value engine: holding, spending and releasing are all
// issueChildGrant / settleGrantUsage / revokeGrantTree, exactly as for any other key.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, recordEvent, sql } from "./db.js";
import { issueChildGrant, revokeGrantTree } from "./grants.js";
import {
  AGENT_ISSUED_MAX_TTL_SEC,
  normalizeUsage,
  remainingBudget,
  TIERS,
  TOUR_IDLE_END_SEC,
  TOUR_MAX_SIGNED_SEC,
  TOUR_MAX_TOTAL_SEC,
  TOUR_MIN_EXTEND_SEC,
  TOUR_RENEW_MIN_GAP_SEC,
  TOUR_REUSE_GRACE_SEC,
} from "./policy.js";

// The reason written on a key that a renewal replaced. verifyGrant looks for exactly this. When the
// owner reissues, every such reason under the tour is rewritten (below): the owner has looked, and a
// key replaced before that can no longer freeze the tour.
export const TOUR_RENEWED = "tour: renewed";
const TOUR_SUPERSEDED = "tour: renewed (before an owner reissue)";
const FROZEN_WHY = "a key this tour had already replaced was used again";
// The agent's name: lowercase letters, digits and dots. Its memory is the section
// agent:<name>: (the closing colon keeps "report" out of "report2"), the same rule the
// front door's key mint uses, so a tour and a one-off key for one name share one memory.
const AGENT_RE = /^[a-z0-9][a-z0-9.]{0,39}$/;
const DAY = 86400;

const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const ownerOnly = (auth) => {
  if (Number(auth.row.depth) !== 0) throw new HttpError(403, "owner_required", { hint: "tours are opened, reissued, extended and ended with the tenant's root grant" });
};
const isDuplicate = (err) => String(err?.errno ?? err?.code ?? "") === "23505" || /duplicate key|unique constraint/i.test(String(err?.message || ""));
// A zero-amount ledger row: the tour's own line on the record, beside the reserve/release
// rows the keys themselves leave.
async function tourLedger(tour, kind, ref, note, approver = null) {
  await sql`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note, approver)
    VALUES (${tour.tenant}, ${tour.grant_id}, ${null}, ${kind}, 0, 0, 0, ${ref}, ${String(note).slice(0, 200)}, ${approver})`;
}
async function ownTour(auth, id) {
  let t = (await sql`SELECT * FROM tours WHERE id = ${String(id)}`)[0];
  if (!t || t.tenant !== auth.tenant.id) throw new HttpError(404, "tour_not_found");
  return t;
}
const rowOf = async (id) => (await sql`SELECT * FROM tours WHERE id = ${id}`)[0];

// Every key that is live under a tour, by PARENT (see the rule at the top).
const keysUnder = (tour) => sql`SELECT id, exp, iat FROM grants WHERE parent = ${tour.grant_id} AND status = 'active' ORDER BY iat DESC`;
// Cancel them all (each with everything it handed out). Throws if one cannot be cancelled:
// the caller must not go on to say "stopped" when something is not.
async function cancelKeysUnder(tour, reason, by) {
  let done = [];
  for (let k of await keysUnder(tour)) done.push(...(await revokeGrantTree(k.id, reason, by)));
  return done;
}
// The next 24-hour key: an ordinary child of the holding grant, with whatever the tour
// still has left. Before it is issued every other key under the tour is cancelled, so there
// is never a second one and what those had not used is back with the tour. The 24-hour cap
// is not applied here; issueChildGrant applies it to every key a non-root key issues.
async function issueDayKey(tour, by) {
  let alive = async () => {
    let h = await getGrant(tour.grant_id);
    if (!h || h.status !== "active" || Number(h.exp) <= nowSec()) throw new HttpError(409, "tour_over");
    return h;
  };
  await alive();
  await cancelKeysUnder(tour, "tour: replaced by a newer key", by);
  let hold = await alive(); // read again: what the cancelled keys had not used is back on it
  return issueChildGrant(
    hold,
    { sub: `agent:${tour.agent}`, caps: parseJson(hold.caps), budget: remainingBudget(hold), ttlSec: AGENT_ISSUED_MAX_TTL_SEC, constraints: parseJson(hold.constraints) },
    by,
  );
}
const keyView = (k) => ({ id: k.row.id, token: k.token, sub: k.row.sub, caps: parseJson(k.row.caps), exp: Number(k.row.exp), budget: parseJson(k.row.budget) });

export async function serializeTour(t) {
  let now = nowSec(),
    hold = await getGrant(t.grant_id),
    live = hold ? (await keysUnder(t)).filter((k) => Number(k.exp) > now) : [],
    mine = live.find((k) => k.id === t.current_key),
    over = !hold || hold.status !== "active" || Number(t.until) <= now,
    budget = hold ? normalizeUsage(parseJson(hold.budget)) : null,
    left = null;
  if (hold) {
    // What the whole tour has NOT used: its budget less everything settled anywhere under it, by any key that
    // ever lived there. (Not "what is held": a key that has run out but not yet been swept still holds its share.)
    let used = { usd_cents: 0, calls: 0, deploys: 0 };
    for (let r of await sql`WITH RECURSIVE sub AS (SELECT id, settled FROM grants WHERE id = ${t.grant_id}
        UNION ALL SELECT g.id, g.settled FROM grants g JOIN sub ON g.parent = sub.id) SELECT settled FROM sub`) {
      let s = normalizeUsage(parseJson(r.settled));
      ((used.usd_cents += s.usd_cents), (used.calls += s.calls), (used.deploys += s.deploys));
    }
    left = { usd_cents: Math.max(0, budget.usd_cents - used.usd_cents), calls: Math.max(0, budget.calls - used.calls), deploys: Math.max(0, budget.deploys - used.deploys) };
  }
  return {
    id: t.id,
    agent: t.agent,
    // what a person needs to know, in one word
    status: t.status === "active" ? (over ? "over" : mine ? "active" : "key_run_out") : t.status,
    opened_at: Number(t.opened_at),
    until: Number(t.until),
    renewals: Number(t.renewals),
    last_renewed_at: Number(t.last_renewed_at),
    key: mine ? { id: mine.id, live: true, exp: Number(mine.exp) } : null,
    // every working key under the tour. More than the one above means a key the tour lost sight of (a step failed
    // half way); nobody was handed it, and the next reissue, freeze or end removes it.
    live_keys: live.length,
    caps: hold ? parseJson(hold.caps) : [],
    budget,
    left,
    frozen_reason: t.frozen_reason || null,
    ended_reason: t.ended_reason || null,
    memory: `agent:${t.agent}:`,
  };
}

// A tour that is finished is marked so, and lets go of the agent's name and of whatever it had not
// spent: its end date has passed, its holding grant is gone (cancelled from outside, or swept), or
// nobody has renewed it for TOUR_IDLE_END_SEC. Runs with the reaper, and for one name before a new
// tour is opened for it.
export async function sweepTours(only = {}) {
  let now = nowSec(),
    rows = await sql`SELECT t.*, g.status AS hold_status FROM tours t LEFT JOIN grants g ON g.id = t.grant_id
      WHERE t.status IN ('active', 'frozen')
        AND (${only.tenant ?? null}::text IS NULL OR t.tenant = ${only.tenant ?? null})
        AND (${only.agent ?? null}::text IS NULL OR t.agent = ${only.agent ?? null})
        AND (t.until <= ${now}::bigint OR g.status IS DISTINCT FROM 'active' OR (t.status = 'active' AND ${now}::bigint - t.last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))
      LIMIT 200`,
    ended = [];
  // A frozen tour has no working key. If one is found (the freeze could not finish cancelling), it goes now.
  if (!only.agent)
    for (let t of await sql`SELECT t.* FROM tours t WHERE t.status = 'frozen' AND (${only.tenant ?? null}::text IS NULL OR t.tenant = ${only.tenant ?? null})
        AND EXISTS (SELECT 1 FROM grants k WHERE k.parent = t.grant_id AND k.status = 'active') LIMIT 200`) {
      try {
        await cancelKeysUnder(t, "tour: frozen (no key works until the owner reissues)", "runtime");
      } catch (err) {
        console.error("ERR tour sweep (frozen)", t.id, err?.message || err);
      }
    }
  for (let t of rows) {
    let why = Number(t.until) <= now ? "its end date passed" : t.hold_status !== "active" ? "its holding grant was cancelled" : "idle: no renewal for too long";
    try {
      await endTourRow(t, why, "runtime");
      ended.push(t.id);
    } catch (err) {
      console.error("ERR tour sweep", t.id, err?.message || err); // left for the next pass
    }
  }
  return ended;
}

// OPEN. Owner only. Validates everything before anything is issued.
export async function openTour(auth, body) {
  ownerOnly(auth);
  let b = plain(body),
    agent = typeof b.agent === "string" ? b.agent : ""; // a list or a number is not a name, however it would print
  if (!AGENT_RE.test(agent)) throw new HttpError(400, "tour_agent_required", { hint: "the agent's name: lowercase letters, digits and dots, 1 to 40 characters" });
  let days = b.days,
    maxDays = TOUR_MAX_SIGNED_SEC / DAY,
    tierMax = TIERS[auth.tenant.tier].maxTtlSec;
  if (!Number.isInteger(days) || days < 1 || days > maxDays) throw new HttpError(400, "tour_days_invalid", { min: 1, max: maxDays });
  if (days * DAY > tierMax) throw new HttpError(403, "tour_exceeds_tier", { tier: auth.tenant.tier, max_days: Math.floor(tierMax / DAY) });
  if (!Array.isArray(b.caps) || !b.caps.length || !b.caps.every((c) => typeof c === "string")) throw new HttpError(400, "tour_caps_required");
  let rawBudget = plain(b.budget);
  // the owner states the money: there is no default budget for something that runs for days
  if (!["usd_cents", "calls", "deploys"].some((k) => Number.isFinite(Number(rawBudget[k])) && Number(rawBudget[k]) > 0)) throw new HttpError(400, "tour_budget_required");
  // One tour per agent name. A finished one no longer holds the name; a live one does. This look is only
  // for a clear answer: the unique index on the table is what actually keeps two opens from both winning.
  await sweepTours({ tenant: auth.tenant.id, agent });
  let live = await sql`SELECT id FROM tours WHERE tenant = ${auth.tenant.id} AND agent = ${agent} AND status IN ('active', 'frozen') LIMIT 1`;
  if (live.length) throw new HttpError(409, "tour_exists", { tour: live[0].id, hint: "one tour per agent name: end that one first" });
  let id = newId("tr"),
    scopeIn = plain(b.scope),
    asked = nowSec() + days * DAY,
    hold = await issueChildGrant(
      auth.row,
      {
        sub: `tour:${agent}`,
        caps: b.caps,
        budget: rawBudget,
        ttlSec: days * DAY,
        // the agent's own memory section and no other; railway and worker scope are inherited or narrowed as on any grant
        scope: { railway: scopeIn.railway, workers: scopeIn.workers, templates: scopeIn.templates, memory: { partitions: [`agent:${agent}:`] } },
        constraints: plain(b.constraints),
      },
      auth.row.sub,
      { tour: { tour_id: id, agent, holder: true } },
    ),
    now = nowSec(),
    until = Number(hold.row.exp),
    // a tour can end sooner than asked for one reason only: the owner's own key ends first. Say so.
    limitedBy = until < asked - 5 ? "owner_key" : "asked",
    tour = { id, tenant: auth.tenant.id, grant_id: hold.row.id, agent, until };
  // hold.token is deliberately dropped here: the holding grant is a record, never a credential.
  // The ROW goes in before any key exists, so the name is taken (or refused) first and a key is never
  // issued for a tour that has no record.
  try {
    await sql`INSERT INTO tours (id, tenant, grant_id, agent, status, current_key, renewals, opened_at, until, last_renewed_at, opened_by)
      VALUES (${id}, ${tour.tenant}, ${tour.grant_id}, ${agent}, 'active', ${null}, 0, ${now}, ${until}, ${now}, ${auth.row.id})`;
  } catch (err) {
    await revokeGrantTree(hold.row.id, "tour: could not be recorded", auth.row.sub); // nothing is left held
    if (isDuplicate(err)) throw new HttpError(409, "tour_exists", { hint: "one tour per agent name: end that one first" });
    throw err;
  }
  let key;
  try {
    key = await issueDayKey(tour, auth.row.sub);
    let noted = await sql`UPDATE tours SET current_key = ${key.row.id} WHERE id = ${id} AND status = 'active' AND current_key IS NULL RETURNING id`;
    if (noted.length !== 1) throw new HttpError(409, "tour_changed");
  } catch (err) {
    // the holding grant, anything under it, and the row. If this fails too, the tour stays on the record with no
    // key (it reads key_run_out) for the owner to end; the first error is still the one to report.
    await endTourRow(tour, "could not issue its first key", auth.row.sub).catch((e) => console.error("ERR tour open clean-up", id, e?.message || e));
    throw err;
  }
  await tourLedger(tour, "tour-open", id, `tour opened for agent ${agent}: asked ${days} day(s), ends ${new Date(until * 1000).toISOString()}${limitedBy === "asked" ? "" : " (sooner: the owner's key ends then)"}`, auth.row.id);
  await recordEvent("tour.opened", { tour: id, agent, days, until, limited_by: limitedBy, key: key.row.id }, tour.tenant, auth.row.sub);
  return { tour: await serializeTour(await rowOf(id)), key: keyView(key), receipt: { tour: id, opened_by: auth.row.id, holding_grant: tour.grant_id, first_key: key.row.id, until, limited_by: limitedBy } };
}

// RENEW. Called WITH the tour's current key. That key is cancelled and the next one issued.
export async function renewTour(auth) {
  let old = auth.row.id,
    tour = (await sql`SELECT * FROM tours WHERE current_key = ${old}`)[0];
  if (!tour) throw new HttpError(404, "not_a_tour_key", { hint: "renew with the tour's current key" });
  if (tour.status !== "active") throw new HttpError(409, `tour_${tour.status}`);
  let wait = Number(tour.last_renewed_at) + TOUR_RENEW_MIN_GAP_SEC - nowSec();
  if (wait > 0) throw new HttpError(429, "tour_renew_too_soon", { retry_in_sec: wait });
  // 1. The key in hand stops (what it had not used goes back to the tour). If this throws, nothing has changed:
  //    the key still works and the agent can simply ask again. If somebody else already stopped it, this caller
  //    is not the one renewing.
  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old)) throw new HttpError(409, "tour_renew_in_progress");
  // 2. The next key. From here the old one is gone, so a failure is said on the record: only the owner can put it right.
  let key;
  try {
    key = await issueDayKey(tour, auth.row.sub);
  } catch (err) {
    let over = err instanceof HttpError && err.code === "tour_over",
      marked = await sql`UPDATE tours SET status = ${over ? "ended" : "frozen"}, frozen_reason = ${over ? null : "a renewal could not issue the next key"},
        ended_reason = ${over ? "ran out at renewal" : null}, current_key = NULL
        WHERE id = ${tour.id} AND status = 'active' AND current_key = ${old} RETURNING id`;
    if (marked.length === 1) {
      await tourLedger(tour, over ? "tour-end" : "tour-freeze", tour.id, over ? "tour ran out at renewal" : "renewal failed: no key issued");
      await recordEvent(over ? "tour.ended" : "tour.frozen", { tour: tour.id, agent: tour.agent, reason: over ? "ran out" : "renewal failed" }, tour.tenant, auth.row.sub);
    }
    throw err;
  }
  // 3. Hand it over ONLY if the tour is still as it was. It may have been frozen (the alarm) or ended while the two
  //    steps above ran; then the new key must not exist.
  let now = nowSec(),
    kept = [];
  try {
    kept = await sql`UPDATE tours SET current_key = ${key.row.id}, renewals = renewals + 1, last_renewed_at = ${now}
      WHERE id = ${tour.id} AND status = 'active' AND current_key = ${old} RETURNING id`;
  } catch (err) {
    await revokeGrantTree(key.row.id, "tour: its renewal could not be recorded", auth.row.sub).catch(() => {}); // never handed out either way
    throw err;
  }
  if (kept.length !== 1) {
    await revokeGrantTree(key.row.id, "tour: changed while it was being renewed", auth.row.sub);
    let t = await rowOf(tour.id);
    throw new HttpError(409, `tour_${t?.status === "active" ? "changed" : t?.status || "gone"}`);
  }
  await tourLedger(tour, "tour-renew", key.row.id, `renewed: ${old} replaced by ${key.row.id}`);
  await recordEvent("tour.renewed", { tour: tour.id, agent: tour.agent, replaced: old, key: key.row.id }, tour.tenant, auth.row.sub);
  return { tour: await serializeTour(await rowOf(tour.id)), key: keyView(key), receipt: { tour: tour.id, replaced_key: old, new_key: key.row.id } };
}

// REISSUE. Owner only: a fresh key for a tour whose key ran out, or one that froze. Every key still
// live under the tour is cancelled first, whichever one the tour's row points at.
export async function reissueTour(auth, id) {
  ownerOnly(auth);
  await sweepTours({ tenant: auth.tenant.id }); // a tour that is finished says so before anything is asked of it
  let tour = await ownTour(auth, id);
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  let key = await issueDayKey(tour, auth.row.sub),
    now = nowSec(),
    set = await sql`UPDATE tours SET status = 'active', frozen_reason = NULL, current_key = ${key.row.id}, last_renewed_at = ${now}
      WHERE id = ${tour.id} AND status IN ('active', 'frozen') AND current_key IS NOT DISTINCT FROM ${tour.current_key} RETURNING id`;
  if (set.length !== 1) {
    await revokeGrantTree(key.row.id, "tour: changed while its key was being reissued", auth.row.sub);
    throw new HttpError(409, "tour_changed", { hint: "it was changed at the same moment: look at it and ask again" });
  }
  // No key replaced before this point can raise the alarm from now on: the owner has looked and started it afresh.
  await sql`UPDATE grants SET revoke_reason = ${TOUR_SUPERSEDED} WHERE parent = ${tour.grant_id} AND revoke_reason = ${TOUR_RENEWED}`;
  await tourLedger(tour, "tour-reissue", key.row.id, `owner reissued the key${tour.status === "frozen" ? " (tour was frozen)" : ""}`, auth.row.id);
  await recordEvent("tour.reissued", { tour: tour.id, agent: tour.agent, key: key.row.id, was: tour.status }, tour.tenant, auth.row.sub);
  return { tour: await serializeTour(await rowOf(tour.id)), key: keyView(key), receipt: { tour: tour.id, reissued_by: auth.row.id, new_key: key.row.id } };
}

// EXTEND (the furlough). Owner only. More days, never more money, and never past the limits.
export async function extendTour(auth, id, body) {
  ownerOnly(auth);
  await sweepTours({ tenant: auth.tenant.id });
  let tour = await ownTour(auth, id),
    days = plain(body).days,
    maxDays = TOUR_MAX_SIGNED_SEC / DAY,
    now = nowSec();
  if (!Number.isInteger(days) || days < 1 || days > maxDays) throw new HttpError(400, "tour_days_invalid", { min: 1, max: maxDays });
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  if (Number(tour.until) <= now) throw new HttpError(409, "tour_over", { hint: "it has already ended: open a new tour" });
  let hold = await getGrant(tour.grant_id),
    root = hold ? await getGrant(hold.parent) : null;
  if (!hold || hold.status !== "active" || !root) throw new HttpError(409, "tour_over");
  // each limit, so the answer can say which one stopped it
  let limits = {
      asked: Number(tour.until) + days * DAY,
      one_signature: now + TOUR_MAX_SIGNED_SEC,
      tier: now + TIERS[auth.tenant.tier].maxTtlSec,
      whole_tour: Number(tour.opened_at) + TOUR_MAX_TOTAL_SEC,
      owner_key: Number(root.exp),
    },
    until = Math.min(...Object.values(limits));
  // an extension is worth a line on the record only if it adds real time
  if (until - Number(tour.until) < TOUR_MIN_EXTEND_SEC) throw new HttpError(409, "tour_at_limit", { until: Number(tour.until), limits });
  // The holding grant's end and the tour's own note of it move together or not at all.
  let moved = await sql.begin(async (tx) => {
    let g = await tx`UPDATE grants SET exp = ${until} WHERE id = ${tour.grant_id} AND status = 'active' AND exp > ${now} RETURNING id`;
    if (g.length !== 1) return !1;
    let t = await tx`UPDATE tours SET until = ${until} WHERE id = ${tour.id} AND status IN ('active', 'frozen') RETURNING id`;
    if (t.length !== 1) throw new HttpError(409, "tour_changed"); // rolls the grant's end back too
    return !0;
  });
  if (!moved) throw new HttpError(409, "tour_over");
  await tourLedger(tour, "tour-extend", tour.id, `extended to ${new Date(until * 1000).toISOString()}`, auth.row.id);
  await recordEvent("tour.extended", { tour: tour.id, agent: tour.agent, from: Number(tour.until), until }, tour.tenant, auth.row.sub);
  return { tour: await serializeTour(await rowOf(tour.id)), receipt: { tour: tour.id, extended_by: auth.row.id, from: Number(tour.until), until, limited_by: Object.keys(limits).find((k) => limits[k] === until) } };
}

async function endTourRow(tour, reason, by, approver = null) {
  let cancelled = await revokeGrantTree(tour.grant_id, `tour: ${reason}`, by); // the holding grant and every key under it, at once
  // A key issued under it while that ran is not in its list. Once the holding grant is no longer active nothing new
  // can be issued under it, so this second look is the last one needed.
  cancelled.push(...(await cancelKeysUnder(tour, `tour: ${reason}`, by)));
  let marked = await sql`UPDATE tours SET status = 'ended', current_key = NULL, ended_reason = ${String(reason).slice(0, 200)} WHERE id = ${tour.id} AND status <> 'ended' RETURNING id`;
  if (marked.length === 1) {
    await tourLedger(tour, "tour-end", tour.id, reason, approver);
    await recordEvent("tour.ended", { tour: tour.id, agent: tour.agent, reason, cancelled }, tour.tenant, by);
  }
  return cancelled;
}
// END. Owner only. The kill for one agent's whole stay.
export async function endTour(auth, id) {
  ownerOnly(auth);
  let tour = await ownTour(auth, id);
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  let cancelled = await endTourRow(tour, "ended by the owner", auth.row.sub, auth.row.id);
  return { tour: await serializeTour(await rowOf(tour.id)), receipt: { tour: tour.id, ended_by: auth.row.id, cancelled_keys: cancelled.length } };
}

// LIST. The owner sees every tour of the tenant; a tour's own key sees its own tour and nothing else.
export async function listTours(auth) {
  let owner = Number(auth.row.depth) === 0;
  if (owner) await sweepTours({ tenant: auth.tenant.id });
  let rows = owner
    ? await sql`SELECT * FROM tours WHERE tenant = ${auth.tenant.id} ORDER BY opened_at DESC LIMIT 100`
    : await sql`SELECT * FROM tours WHERE tenant = ${auth.tenant.id} AND current_key = ${auth.row.id}`;
  return Promise.all(rows.map(serializeTour));
}

// THE ALARM. verifyGrant calls this when a key carrying the "a renewal replaced me" reason is presented again.
// Inside the grace it is a call that was in flight when the agent renewed; after it, a second copy of the key
// exists somewhere. Never throws: the caller is about to answer 401 either way.
//
// ORDER MATTERS. The keys are stopped FIRST and the tour is marked frozen only after that worked, so a tour never
// reads "frozen" while a key under it still works. If stopping them fails, nothing is marked and the very next use
// of the old key tries again. Using the dead key again while the tour is frozen only repeats the cancelling (there
// is nothing left to cancel) and writes nothing; once the owner reissues, it can do nothing at all.
export async function tourKeyReused(oldKey) {
  try {
    // asked of the database's own clock, the one that wrote revoked_at
    let due = await sql`SELECT 1 FROM grants WHERE id = ${oldKey.id} AND revoke_reason = ${TOUR_RENEWED}
      AND revoked_at < now() - make_interval(secs => ${TOUR_REUSE_GRACE_SEC}::int)`;
    if (!due.length) return false;
    let tour = (await sql`SELECT * FROM tours WHERE grant_id = ${oldKey.parent} AND status IN ('active', 'frozen')`)[0];
    // Not directly under a live tour's holding grant (a helper's key, or the tour is over): no alarm.
    // The tour's CURRENT key is never "replaced", whatever reason somebody wrote on it when cancelling it.
    if (!tour || tour.current_key === oldKey.id) return false;
    await cancelKeysUnder(tour, "tour: frozen (a replaced key was used again)", "runtime");
    // (already frozen: an earlier alarm marked it but could not finish cancelling; this use finishes that)
    let frozen = tour.status !== "active" ? [] : await sql`UPDATE tours SET status = 'frozen', frozen_reason = ${FROZEN_WHY}, current_key = NULL
      WHERE id = ${tour.id} AND status = 'active' RETURNING id`;
    // once more: a renewal that was in hand may have issued a key between the two statements above
    await cancelKeysUnder(tour, "tour: frozen (a replaced key was used again)", "runtime");
    if (frozen.length !== 1) return false; // someone else froze or ended it first
    await tourLedger(tour, "tour-freeze", oldKey.id, `frozen: replaced key ${oldKey.id} was used again`);
    await recordEvent("tour.frozen", { tour: tour.id, agent: tour.agent, reused_key: oldKey.id }, tour.tenant, "runtime");
    return true;
  } catch (err) {
    console.error("ERR tour reuse alarm (it will be tried again at the key's next use)", err?.message || err);
    return false;
  }
}
