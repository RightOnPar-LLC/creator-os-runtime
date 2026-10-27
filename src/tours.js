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
// TWO RULES HOLD THIS FILE TOGETHER.
//
// 1. KEYS ARE FOUND BY PARENT. A tour's keys are every active grant under its holding
//    grant, at any depth. `tours.current_key` is only a note of the key the tour handed
//    out last. Anything that must stop the agent goes by parent, never by that note, so a
//    step that fails half way cannot leave a key working that the tour has lost sight of.
//
// 2. TURNS. Nothing here runs inside one database transaction: a renewal is "cancel the
//    old key, issue the next, write it down", and a freeze, a reissue, the sweep or a
//    second renewal can land between any two of those. So the tour's row carries a number,
//    `gen`, and every step that will issue a key first TAKES A TURN: it adds one to `gen`
//    in a single statement that only succeeds if the row is still as it was read. Then:
//      - the key it issues is marked with its turn (scope.tour.gen);
//      - it writes its key onto the row only if `gen` is still its own, otherwise it
//        cancels its own key and answers 409: somebody took a later turn;
//      - whoever cancels keys (a later turn, the alarm, the sweep) cancels only keys of
//        turns UP TO the one it saw on the row. A key from a later turn is never touched
//        by something that looked at the tour before that turn was taken.
//    So the latest turn always wins, a loser never destroys the winner's key, and a key is
//    handed out only by the step whose turn it still is.
//
// Nothing here is a new value engine: holding, spending and releasing are all
// issueChildGrant / settleGrantUsage / revokeGrantTree, exactly as for any other key.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, recordEvent, sql } from "./db.js";
import { checkNamedRateLimit, endedAbove, issueChildGrant, revokeGrantTree } from "./grants.js";
import {
  AGENT_ISSUED_MAX_TTL_SEC,
  normalizeUsage,
  remainingBudget,
  TIERS,
  TOUR_ALARM_MAX_PER_MIN,
  TOUR_IDLE_END_SEC,
  TOUR_MAX_SIGNED_SEC,
  TOUR_MAX_TOTAL_SEC,
  TOUR_MIN_EXTEND_SEC,
  TOUR_RENEW_MIN_GAP_SEC,
  TOUR_REUSE_GRACE_SEC,
} from "./policy.js";

// The reason written on a key that a renewal replaced. verifyGrant looks for exactly this: such a key,
// used again after the grace, is the alarm. Two things take that reason off again, so the key is then
// just a dead key: the owner reissuing (the owner has looked; TOUR_SUPERSEDED), and the renewal itself
// not finishing (nobody was handed a next key, so there is no second holder to catch; TOUR_UNFINISHED).
export const TOUR_RENEWED = "tour: renewed";
const TOUR_SUPERSEDED = "tour: renewed (before an owner reissue)";
const TOUR_UNFINISHED = "tour: its renewal did not finish";
const FROZEN_WHY = "a key this tour had already replaced was used again";
const FROZEN_CANCEL = "tour: frozen (no key works until the owner reissues)";
// Every reason this file writes begins "tour:", and the alarm reads one of them back. So nobody else may write one:
// the three doors that cancel a key with a reason the caller gives (routes/grants.js, routes/admin.js, routes/mcp.js)
// refuse a reason that begins so.
export function notATourReason(reason) {
  if (/^\s*tour:/i.test(String(reason ?? ""))) throw new HttpError(400, "reason_reserved", { hint: 'a reason beginning "tour:" is written by the runtime only' });
}
// The agent's name: lowercase letters, digits and dots. Its memory is the section
// agent:<name>: (the closing colon keeps "report" out of "report2"), the same rule the
// front door's key mint uses, so a tour and a one-off key for one name share one memory.
const AGENT_RE = /^[a-z0-9][a-z0-9.]{0,39}$/;
const DAY = 86400;
const EVERY_TURN = Number.MAX_SAFE_INTEGER;

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
// The answer for a step that found the tour no longer as it left it.
const changed = async (id) => {
  let t = await rowOf(id);
  return new HttpError(409, `tour_${!t ? "gone" : t.status === "active" ? "changed" : t.status}`, { hint: "the tour changed at the same moment: look at it and ask again" });
};
// The tour is ENDING under a step that was about to issue a key, whatever its row still says: its holding grant was
// cancelled (the owner's end, or the ordinary grants route; or a grant above it, which makes it as dead), or its end
// date has passed. The step answers 409 with this and writes nothing: the end, or the sweep, says what happened.
// (Without this a renewal said "frozen" on the record of a tour the owner had just ended, and a reissue answered the
// owner 403 parent_not_active.)
const ending = async (tour) => {
  let hold = await getGrant(tour.grant_id);
  if (!hold || hold.status !== "active" || (await endedAbove(sql, hold.id))) return "tour_ended";
  return Number(hold.exp) <= nowSec() ? "tour_over" : null;
};
// A line on the record (ledger, event) after a hand-over that is already done: logged if it cannot be written, never
// answered. The answer is the only thing that carries the key.
const recordOrLog = (what, fn) => fn().catch((err) => console.error(`ERR tour: ${what} could not be written (the key was handed over)`, err?.message || err));

// RULE 1 and RULE 2 in one query: every grant still ACTIVE anywhere under the holding grant, whose day key
// (the grant directly under the holding grant that it hangs from) belongs to a turn up to `gen`. Shallowest
// first. It walks down from the day keys WHATEVER their own state, so a helper that outlived a cancelled day
// key is found too. (That was the gap revokeGrantTree had until 2026-10-09: a key written at the very moment the
// key above it was cancelled. The cancel now finds such a key itself; this stays as a second look.)
const liveUnder = (tour, gen) => sql`WITH RECURSIVE sub AS (
    SELECT id, status, depth FROM grants WHERE parent = ${tour.grant_id} AND COALESCE((scope->'tour'->>'gen')::bigint, 0) <= ${gen}::bigint
    UNION ALL SELECT c.id, c.status, c.depth FROM grants c JOIN sub ON c.parent = sub.id)
  SELECT id FROM sub WHERE status = 'active' ORDER BY depth ASC`;
// Cancel them, and LOOK AGAIN until a look finds nothing: a key can be written under one of them in the
// moment it is being cancelled. Throws if something is still working at the end, so the caller never goes
// on to say "stopped" when it is not.
async function cancelUnder(tour, gen, reason, by) {
  let done = [];
  for (let look = 0; look < 5; look++) {
    let live = await liveUnder(tour, gen);
    if (!live.length) return done;
    for (let k of live) done.push(...(await revokeGrantTree(k.id, reason, by)));
  }
  if ((await liveUnder(tour, gen)).length) throw new Error("tour: keys under it could not all be cancelled");
  return done;
}
// The next 24-hour key, for the step whose turn is `gen`: an ordinary child of the holding grant with
// whatever the tour still has left, marked with that turn. (The 24-hour cap is not applied here;
// issueChildGrant applies it to every key a non-root key issues.)
//
// THE NEW KEY GETS EVERYTHING THE TOUR HAS LEFT, so no key of a turn up to this one may be holding any of it
// when the amount is worked out. The holding grant and "is any such key still working" are therefore read in
// ONE statement, which sees one moment: either such a key is working (it is cancelled, and this starts again)
// or none is, and then what the holding grant has left at that same moment is exactly what the new key may
// have. If a key is written after that moment, the amount is too large and the issue itself is refused by the
// ordinary rule (more than the parent has left): this starts again. Read apart, the two can disagree: a key
// counted in the amount can be gone by the time the look comes, and the new key is given too little.
// (A LATER turn's key is not this turn's to cancel. This turn then gets less, or nothing, and loses at the
// next step anyway: its key is never handed out.)
const holdAsItIs = async (tour, gen) =>
  (
    await sql`WITH RECURSIVE sub AS (
      SELECT id, status FROM grants WHERE parent = ${tour.grant_id} AND COALESCE((scope->'tour'->>'gen')::bigint, 0) <= ${gen}::bigint
      UNION ALL SELECT c.id, c.status FROM grants c JOIN sub ON c.parent = sub.id)
    SELECT h.*, (SELECT count(*) FROM sub WHERE status = 'active')::int AS still_working FROM grants h WHERE h.id = ${tour.grant_id}`
  )[0];
async function issueDayKey(tour, by, gen) {
  for (let attempt = 0; ; attempt++) {
    let hold = await holdAsItIs(tour, gen);
    if (!hold || hold.status !== "active" || Number(hold.exp) <= nowSec()) throw new HttpError(409, "tour_over");
    if (Number(hold.still_working)) {
      await cancelUnder(tour, gen, "tour: replaced by a newer key", by);
      if (attempt < 8) continue;
      throw new Error("tour: keys keep being written under it");
    }
    try {
      return await issueChildGrant(
        hold,
        { sub: `agent:${tour.agent}`, caps: parseJson(hold.caps), budget: remainingBudget(hold), ttlSec: AGENT_ISSUED_MAX_TTL_SEC, constraints: parseJson(hold.constraints) },
        by,
        { tour: { tour_id: tour.id, agent: tour.agent, gen } },
      );
    } catch (err) {
      if (attempt < 8 && err?.message === "budget_exceeds_parent_remaining") continue;
      throw err;
    }
  }
}
const keyView = (k) => ({ id: k.row.id, token: k.token, sub: k.row.sub, caps: parseJson(k.row.caps), exp: Number(k.row.exp), budget: parseJson(k.row.budget) });

export async function serializeTour(t) {
  let now = nowSec(),
    hold = await getGrant(t.grant_id),
    live = hold ? (await sql`SELECT id, exp FROM grants WHERE parent = ${t.grant_id} AND status = 'active'`).filter((k) => Number(k.exp) > now) : [],
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
    // every working key directly under the tour. More than the one above means a key the tour lost sight of (a
    // step failed half way); nobody was handed it, and the next reissue, freeze or end removes it.
    live_keys: live.length,
    caps: hold ? parseJson(hold.caps) : [],
    budget,
    left,
    frozen_reason: t.frozen_reason || null,
    ended_reason: t.ended_reason || null,
    memory: `agent:${t.agent}:`,
  };
}

// The sweep. Runs with the reaper, and inside the owner's own requests. Two jobs:
//   - a FROZEN tour has no working key: anything found working under one is cancelled (a freeze that could
//     not finish, or a step that died after issuing);
//   - a tour that is finished is marked so, and lets go of the agent's name and of whatever it had not
//     spent: its end date has passed, its holding grant is gone (cancelled from outside, or swept), or
//     nobody has renewed it for TOUR_IDLE_END_SEC. A frozen tour is not ended for being idle: it waits for
//     the owner until its end date.
// The order is random so that one tour that keeps failing cannot keep the rest from their place in the list.
export async function sweepTours(only = {}) {
  let tenant = only.tenant ?? null,
    agent = only.agent ?? null,
    ended = [];
  if (!agent)
    for (let t of await sql`SELECT * FROM tours WHERE status = 'frozen' AND (${tenant}::text IS NULL OR tenant = ${tenant}) ORDER BY random() LIMIT 200`) {
      try {
        await cancelUnder(t, Number(t.gen), FROZEN_CANCEL, "runtime"); // only keys of turns up to the one seen: a reissue under way is left alone
      } catch (err) {
        console.error("ERR tour sweep (frozen)", t.id, err?.message || err);
      }
    }
  let now = nowSec(),
    rows = await sql`SELECT t.*, g.status AS hold_status FROM tours t LEFT JOIN grants g ON g.id = t.grant_id
      WHERE t.status IN ('active', 'frozen')
        AND (${tenant}::text IS NULL OR t.tenant = ${tenant})
        AND (${agent}::text IS NULL OR t.agent = ${agent})
        AND (t.until <= ${now}::bigint OR g.status IS DISTINCT FROM 'active' OR (t.status = 'active' AND ${now}::bigint - t.last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))
      ORDER BY random() LIMIT 200`;
  for (let t of rows) {
    try {
      // The list above is already old. ONE statement looks again and takes the turn: it succeeds only if the tour
      // is STILL finished, as its row and its holding grant are now. (A renewal or a reissue since then has reset
      // the idle clock; an extension has moved the end date.) Taking the turn stops a renewal in hand from handing
      // out a key under a tour that is being ended.
      let mine = await sql`UPDATE tours SET gen = gen + 1 WHERE id = ${t.id} AND status IN ('active', 'frozen')
        AND (until <= ${now}::bigint OR NOT EXISTS (SELECT 1 FROM grants g WHERE g.id = tours.grant_id AND g.status = 'active')
          OR (status = 'active' AND ${now}::bigint - last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))
        RETURNING id`;
      if (mine.length !== 1) continue; // it is no longer finished (extended, reissued, renewed): the next pass looks afresh
      let why = Number(t.until) <= now ? "its end date passed" : t.hold_status !== "active" ? "its holding grant was cancelled" : "idle: no renewal for too long";
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
  // The ROW goes in before any key exists (turn 0), so the name is taken (or refused) first and a key is
  // never issued for a tour that has no record.
  try {
    await sql`INSERT INTO tours (id, tenant, grant_id, agent, status, current_key, renewals, opened_at, until, last_renewed_at, opened_by, gen)
      VALUES (${id}, ${tour.tenant}, ${tour.grant_id}, ${agent}, 'active', ${null}, 0, ${now}, ${until}, ${now}, ${auth.row.id}, 0)`;
  } catch (err) {
    await revokeGrantTree(hold.row.id, "tour: could not be recorded", auth.row.sub); // nothing is left held
    if (isDuplicate(err)) throw new HttpError(409, "tour_exists", { hint: "one tour per agent name: end that one first" });
    throw err;
  }
  let key;
  try {
    key = await issueDayKey(tour, auth.row.sub, 0);
    let noted = await sql`UPDATE tours SET current_key = ${key.row.id} WHERE id = ${id} AND status = 'active' AND gen = 0 RETURNING id`;
    if (noted.length !== 1) throw await changed(id);
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

// The old key of a renewal that did not finish is just a dead key: nobody was handed a next one.
const notAnAlarm = (keyId) => sql`UPDATE grants SET revoke_reason = ${TOUR_UNFINISHED} WHERE id = ${keyId} AND revoke_reason = ${TOUR_RENEWED}`.catch(() => {});

// RENEW. Called WITH the tour's current key. That key is cancelled and the next one issued.
export async function renewTour(auth) {
  let old = auth.row.id,
    tour = (await sql`SELECT * FROM tours WHERE current_key = ${old}`)[0];
  if (!tour) throw new HttpError(404, "not_a_tour_key", { hint: "renew with the tour's current key" });
  if (tour.status !== "active") throw new HttpError(409, `tour_${tour.status}`);
  let wait = Number(tour.last_renewed_at) + TOUR_RENEW_MIN_GAP_SEC - nowSec();
  if (wait > 0) throw new HttpError(429, "tour_renew_too_soon", { retry_in_sec: wait });
  // 1. The key in hand stops (what it had not used goes back to the tour). This is also what lets only ONE of two
  //    renewals with the same key go on: a key is cancelled by exactly one caller. The other has changed nothing.
  //    If this throws, nothing has changed either: the key still works and the agent can simply ask again.
  //    (Also: a key cancelled from outside in the instant after this request was let in stays cancelled. The owner's
  //    kill of one key is not undone by a renewal that was already on its way.)
  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old)) throw new HttpError(409, "tour_key_cancelled", { hint: "this key was cancelled a moment ago, by another renewal or by the owner" });
  // 2. Take the turn, now that this renewal alone holds it. (A renewal must not take a turn before that: one that
  //    took a turn and then found its key already cancelled could not go on, and would have taken the turn away
  //    from the renewal that could.) It fails only if the tour no longer points at this key: a reissue or a
  //    freeze took a turn in between. Then nobody is handed a next key by this renewal, so its old key is no alarm.
  let turn = await sql`UPDATE tours SET gen = gen + 1 WHERE id = ${tour.id} AND status = 'active' AND current_key = ${old} RETURNING gen`;
  if (turn.length !== 1) {
    await notAnAlarm(old);
    throw await changed(tour.id);
  }
  let gen = Number(turn[0].gen);
  // 3. The next key. From here the old one is gone, so a failure is said on the record: only the owner can put it right.
  let key;
  try {
    key = await issueDayKey(tour, auth.row.sub, gen);
  } catch (err) {
    await notAnAlarm(old);
    // The tour is ending underneath (ending): nothing is frozen and nothing is written. 409.
    let over = await ending(tour);
    if (over) throw new HttpError(409, over, { hint: "the tour ended at the same moment: nobody is handed a key" });
    // The key may exist although the issue is said to have failed (written and committed, then the step after it threw).
    // By parent, before the tour is marked: a tour never reads frozen while a key under it works. If it cannot be
    // cancelled the tour is not marked either (it stays active with a dead key noted and reads key_run_out, for the
    // owner); the first error is still the one to report.
    try {
      await cancelUnder(tour, gen, TOUR_UNFINISHED, auth.row.sub);
    } catch (e) {
      console.error("ERR tour renew: a key its failed issue left behind could not be cancelled", tour.id, e?.message || e);
      throw err;
    }
    let marked = await sql`UPDATE tours SET status = 'frozen', frozen_reason = 'a renewal could not issue the next key', current_key = NULL, gen = gen + 1
      WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id`;
    if (marked.length !== 1) throw await changed(tour.id); // a later turn has the tour now; what happens to it is that turn's to say
    await tourLedger(tour, "tour-freeze", tour.id, "renewal failed: no key issued");
    await recordEvent("tour.frozen", { tour: tour.id, agent: tour.agent, reason: "renewal failed" }, tour.tenant, auth.row.sub);
    throw err;
  }
  // 4. Hand it over ONLY if it is still this renewal's turn. The tour may have been frozen (the alarm), reissued
  //    or ended while the steps above ran; then the new key must not exist.
  let now = nowSec(),
    kept = [];
  try {
    kept = await sql`UPDATE tours SET current_key = ${key.row.id}, renewals = renewals + 1, last_renewed_at = ${now}
      WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id`;
  } catch (err) {
    await revokeGrantTree(key.row.id, "tour: its renewal could not be recorded", auth.row.sub).catch(() => {}); // never handed out either way
    await notAnAlarm(old);
    throw err;
  }
  if (kept.length !== 1) {
    await revokeGrantTree(key.row.id, "tour: changed while it was being renewed", auth.row.sub);
    await notAnAlarm(old);
    throw await changed(tour.id);
  }
  // 5. The lines on the record. The hand-over is done and only this answer carries the key, so a line that cannot be
  //    written is logged, never a 500 (which would leave the agent with no key and a tour only the owner can put right).
  await recordOrLog("the tour-renew line", () => tourLedger(tour, "tour-renew", key.row.id, `renewed: ${old} replaced by ${key.row.id}`));
  await recordOrLog("the tour.renewed event", () => recordEvent("tour.renewed", { tour: tour.id, agent: tour.agent, replaced: old, key: key.row.id }, tour.tenant, auth.row.sub));
  return { tour: await serializeTour(await rowOf(tour.id)), key: keyView(key), receipt: { tour: tour.id, replaced_key: old, new_key: key.row.id } };
}

// REISSUE. Owner only: a fresh key for a tour whose key ran out, or one that froze. Every key still
// live under the tour is cancelled first, whichever one the tour's row points at.
export async function reissueTour(auth, id) {
  ownerOnly(auth);
  await sweepTours({ tenant: auth.tenant.id }); // a tour that is finished says so before anything is asked of it
  let tour = await ownTour(auth, id);
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  // 1. No key replaced before this point can raise the alarm any more: the owner has looked, and is starting the
  //    tour afresh. Done in the same transaction as step 2, so that an old key being tried again at this very moment
  //    sees either the tour as it was and its reason as it was, or the tour afresh and its reason gone: never the
  //    tour afresh with the alarm still set (the alarm looks at the tour, and only then at the key's reason).
  // 2. Take the turn, and in the same statement the tour is active again with no key noted. From here the sweep
  //    and a late alarm, which saw an earlier turn, cannot touch the key this turn issues.
  // ONE TRANSACTION for the two. A reissue that loses its turn has cleared the alarm for a reissue that did not
  // happen, and putting the reason back afterwards cannot tell "a renewal won" from "a renewal bumped and another
  // reissue is one statement from winning" (the row reads the same). So nothing is put back: a lost turn throws inside
  // the transaction and the clearing is rolled back with it, on exactly the keys it touched. To everyone else the
  // clearing and the turn appear together, which is what the alarm's own ordering needs (it reads the tour, then the
  // key's reason).
  let now = nowSec(),
    lost = false,
    turn = await sql
      .begin(async (tx) => {
        lost = false; // (per attempt: a flag left over from an earlier run of this callback must never swallow a real error)
        await tx`UPDATE grants SET revoke_reason = ${TOUR_SUPERSEDED} WHERE parent = ${tour.grant_id} AND revoke_reason = ${TOUR_RENEWED}`;
        let t = await tx`UPDATE tours SET gen = gen + 1, status = 'active', frozen_reason = NULL, current_key = NULL, last_renewed_at = ${now}
          WHERE id = ${tour.id} AND status IN ('active', 'frozen') AND gen = ${Number(tour.gen)}::bigint RETURNING gen`;
        if (t.length !== 1) {
          lost = true;
          throw new Error("tour: this reissue lost its turn"); // rolls the clearing back
        }
        return t;
      })
      .catch((err) => {
        if (lost) return [];
        throw err;
      });
  if (turn.length !== 1) throw await changed(tour.id);
  let gen = Number(turn[0].gen),
    key;
  // 3. The key. If it cannot be issued the tour is left active with no key (it reads key_run_out): ask again. Unless
  //    the tour is ending underneath (its holding grant cancelled): 409, as for a renewal.
  try {
    key = await issueDayKey(tour, auth.row.sub, gen);
  } catch (err) {
    let over = await ending(tour);
    if (over) throw new HttpError(409, over, { hint: "the tour ended at the same moment" });
    if (Number((await rowOf(tour.id))?.gen) !== gen) throw await changed(tour.id);
    throw err;
  }
  // 4. Write it down only if it is still this reissue's turn, and answer with it only if it really works.
  let noted = await sql`UPDATE tours SET current_key = ${key.row.id} WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id`;
  if (noted.length !== 1 || (await getGrant(key.row.id))?.status !== "active") {
    await revokeGrantTree(key.row.id, "tour: changed while its key was being reissued", auth.row.sub);
    throw await changed(tour.id);
  }
  await tourLedger(tour, "tour-reissue", key.row.id, `owner reissued the key${tour.status === "frozen" ? " (tour was frozen)" : ""}`, auth.row.id);
  await recordEvent("tour.reissued", { tour: tour.id, agent: tour.agent, key: key.row.id, was: tour.status }, tour.tenant, auth.row.sub);
  return { tour: await serializeTour(await rowOf(tour.id)), key: keyView(key), receipt: { tour: tour.id, reissued_by: auth.row.id, new_key: key.row.id } };
}

// EXTEND (the furlough). Owner only. More days, never more money, and never past the limits.
// It takes no turn: more days change nothing about which key is the tour's, and must not undo a renewal in hand.
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
  // A key written under it (or under one of its keys) while that ran was not in its list; since 2026-10-09 the
  // cancel looks again itself, and this is a second look on top of that. Look until a look finds nothing, at every
  // depth and whatever the turn; throws, and the tour is NOT marked ended, if something still works.
  cancelled.push(...(await cancelUnder(tour, EVERY_TURN, `tour: ${reason}`, by)));
  let marked = await sql`UPDATE tours SET status = 'ended', current_key = NULL, ended_reason = ${String(reason).slice(0, 200)}, gen = gen + 1 WHERE id = ${tour.id} AND status <> 'ended' RETURNING id`;
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

// LIST. The owner sees every tour of the tenant; a tour's own key sees its own tour and nothing else. Live tours (active
// or frozen) come first, so that an older open tour is always among the 100 shown (the front door's confirm page picks
// from this list); among themselves, newest first.
export async function listTours(auth) {
  let owner = Number(auth.row.depth) === 0;
  if (owner) await sweepTours({ tenant: auth.tenant.id });
  let rows = owner
    ? await sql`SELECT * FROM tours WHERE tenant = ${auth.tenant.id} ORDER BY (status IN ('active', 'frozen')) DESC, opened_at DESC LIMIT 100`
    : await sql`SELECT * FROM tours WHERE tenant = ${auth.tenant.id} AND current_key = ${auth.row.id}`;
  return Promise.all(rows.map(serializeTour));
}

// THE ALARM. verifyGrant calls this when a key carrying the "a renewal replaced me" reason is presented again.
// Inside the grace it is a call that was in flight when the agent renewed; after it, a second copy of the key
// exists somewhere. Never throws: the caller is about to answer 401 either way.
//
// ORDER MATTERS, three times over.
//   - The TOUR is read first and the key's reason only after it. An owner reissue takes the reason off in the SAME
//     TRANSACTION in which it makes the tour active again, so an old key tried during a reissue either sees the tour as it was before
//     (and can only cancel keys of turns up to that one), or sees the tour after and finds its reason gone.
//   - The keys are stopped FIRST and the tour is marked frozen only after that worked, so a tour never reads
//     "frozen" while a key under it still works. If stopping them fails, nothing is marked and the very next use
//     of the old key tries again.
//   - The mark succeeds only if no turn was taken since the tour was read. If one was (a renewal in hand), the
//     tour is looked at again as it is now, so that turn's key is stopped as well.
// Using the dead key again while the tour is frozen only repeats the cancelling (there is nothing left to
// cancel) and writes nothing; once the owner reissues, it can do nothing at all.
export async function tourKeyReused(oldKey) {
  try {
    for (let look = 0; look < 4; look++) {
      let tour = (await sql`SELECT * FROM tours WHERE grant_id = ${oldKey.parent} AND status IN ('active', 'frozen')`)[0];
      // Not directly under a live tour's holding grant (a helper's key, or the tour is over): no alarm.
      // The tour's CURRENT key is never "replaced", whatever reason somebody wrote on it when cancelling it.
      if (!tour || tour.current_key === oldKey.id) return false;
      // Counted once per use, here between the two reads: a dead key under a live tour may make the runtime look under
      // that tour at most TOUR_ALARM_MAX_PER_MIN times a minute (the sweep looks every minute regardless). Over that,
      // nothing more is read or written for it; a key that is due raises the alarm at the next minute at the latest.
      if (look === 0 && !(await checkNamedRateLimit(`tour-alarm:${oldKey.id}`, TOUR_ALARM_MAX_PER_MIN))) return false;
      // asked of the database's own clock, the one that wrote revoked_at
      let due = await sql`SELECT 1 FROM grants WHERE id = ${oldKey.id} AND revoke_reason = ${TOUR_RENEWED}
        AND revoked_at < now() - make_interval(secs => ${TOUR_REUSE_GRACE_SEC}::int)`;
      if (!due.length) return false;
      let gen = Number(tour.gen);
      await cancelUnder(tour, gen, FROZEN_CANCEL, "runtime");
      if (tour.status !== "active") return false; // already frozen: an earlier alarm marked it; this use only finished the cancelling
      let frozen = await sql`UPDATE tours SET status = 'frozen', frozen_reason = ${FROZEN_WHY}, current_key = NULL, gen = gen + 1
        WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id`;
      if (frozen.length !== 1) continue; // a turn was taken meanwhile: look at the tour as it is now
      // once more: a turn up to this one may have written its key between the two statements above
      await cancelUnder(tour, gen, FROZEN_CANCEL, "runtime");
      await tourLedger(tour, "tour-freeze", oldKey.id, `frozen: replaced key ${oldKey.id} was used again`);
      await recordEvent("tour.frozen", { tour: tour.id, agent: tour.agent, reused_key: oldKey.id }, tour.tenant, "runtime");
      return true;
    }
    return false;
  } catch (err) {
    console.error("ERR tour reuse alarm (it will be tried again at the key's next use)", err?.message || err);
    return false;
  }
}
