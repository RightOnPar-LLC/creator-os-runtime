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
//     for calls that were in flight), somebody else has a copy. The tour FREEZES, its
//     current key is cancelled, and it stays frozen until the owner reissues or ends it.
//   - Miss a renewal and the key simply runs out. Only the owner can reissue.
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
  TOUR_RENEW_MIN_GAP_SEC,
  TOUR_REUSE_GRACE_SEC,
} from "./policy.js";

// The reason written on a key that a renewal replaced. verifyGrant looks for exactly this.
export const TOUR_RENEWED = "tour: renewed";
// The agent's name: lowercase letters, digits and dots. Its memory is the section
// agent:<name>: (the closing colon keeps "report" out of "report2"), the same rule the
// front door's key mint uses, so a tour and a one-off key for one name share one memory.
const AGENT_RE = /^[a-z0-9][a-z0-9.]{0,39}$/;
const DAY = 86400;

const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const ownerOnly = (auth) => {
  if (Number(auth.row.depth) !== 0) throw new HttpError(403, "owner_required", { hint: "tours are opened, reissued, extended and ended with the tenant's root grant" });
};
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
// The next 24-hour key: an ordinary child of the holding grant, with whatever the tour
// still has left. The 24-hour cap is not applied here; issueChildGrant applies it to
// every key a non-root key issues, and the holding grant is one.
async function issueDayKey(tour, by) {
  let hold = await getGrant(tour.grant_id);
  if (!hold || hold.status !== "active" || Number(hold.exp) <= nowSec()) throw new HttpError(409, "tour_over");
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
    key = t.current_key ? await getGrant(t.current_key) : null,
    keyLive = !!key && key.status === "active" && Number(key.exp) > now,
    over = !hold || hold.status !== "active" || Number(t.until) <= now;
  return {
    id: t.id,
    agent: t.agent,
    // what a person needs to know, in one word
    status: t.status === "active" ? (over ? "over" : keyLive ? "active" : "key_run_out") : t.status,
    opened_at: Number(t.opened_at),
    until: Number(t.until),
    renewals: Number(t.renewals),
    last_renewed_at: Number(t.last_renewed_at),
    key: key ? { id: key.id, live: keyLive, exp: Number(key.exp) } : null,
    caps: hold ? parseJson(hold.caps) : [],
    budget: hold ? normalizeUsage(parseJson(hold.budget)) : null,
    // what the whole tour has not yet spent: the holding grant's own remainder plus what the live key still holds
    left: hold ? (keyLive ? addLeft(remainingBudget(hold), remainingBudget(key)) : remainingBudget(hold)) : null,
    frozen_reason: t.frozen_reason || null,
    memory: `agent:${t.agent}:`,
  };
}
const addLeft = (a, b) => ({ usd_cents: a.usd_cents + b.usd_cents, calls: a.calls + b.calls, deploys: a.deploys + b.deploys });

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
  let live = await sql`SELECT id FROM tours WHERE tenant = ${auth.tenant.id} AND agent = ${agent} AND status IN ('active', 'frozen') AND until > ${nowSec()} LIMIT 1`;
  if (live.length) throw new HttpError(409, "tour_exists", { tour: live[0].id, hint: "one tour per agent name: end that one first" });
  let id = newId("tr"),
    scopeIn = plain(b.scope),
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
    tour = { id, tenant: auth.tenant.id, grant_id: hold.row.id, agent, until: Number(hold.row.exp) },
    key;
  // hold.token is deliberately dropped here: the holding grant is a record, never a credential.
  try {
    key = await issueDayKey(tour, auth.row.sub);
  } catch (err) {
    await revokeGrantTree(hold.row.id, "tour: could not issue its first key", auth.row.sub); // nothing is left held
    throw err;
  }
  await sql`INSERT INTO tours (id, tenant, grant_id, agent, status, current_key, renewals, opened_at, until, last_renewed_at, opened_by)
    VALUES (${id}, ${tour.tenant}, ${tour.grant_id}, ${agent}, 'active', ${key.row.id}, 0, ${now}, ${tour.until}, ${now}, ${auth.row.id})`;
  await tourLedger(tour, "tour-open", id, `tour opened for agent ${agent}, ${days} day(s)`, auth.row.id);
  await recordEvent("tour.opened", { tour: id, agent, days, until: tour.until, key: key.row.id }, tour.tenant, auth.row.sub);
  let row = (await sql`SELECT * FROM tours WHERE id = ${id}`)[0];
  return { tour: await serializeTour(row), key: keyView(key), receipt: { tour: id, opened_by: auth.row.id, holding_grant: tour.grant_id, first_key: key.row.id } };
}

// RENEW. Called WITH the tour's current key. That key is cancelled and the next one issued.
export async function renewTour(auth) {
  let tour = (await sql`SELECT * FROM tours WHERE current_key = ${auth.row.id}`)[0];
  if (!tour) throw new HttpError(404, "not_a_tour_key", { hint: "renew with the tour's current key" });
  if (tour.status !== "active") throw new HttpError(409, `tour_${tour.status}`);
  let wait = Number(tour.last_renewed_at) + TOUR_RENEW_MIN_GAP_SEC - nowSec();
  if (wait > 0) throw new HttpError(429, "tour_renew_too_soon", { retry_in_sec: wait });
  // Take the tour for this renewal: only one caller can turn current_key from this key to nothing.
  let mine = await sql`UPDATE tours SET current_key = NULL WHERE id = ${tour.id} AND current_key = ${auth.row.id} AND status = 'active' RETURNING id`;
  if (mine.length !== 1) throw new HttpError(409, "tour_renew_in_progress");
  let key;
  try {
    await revokeGrantTree(auth.row.id, TOUR_RENEWED, auth.row.sub); // its unspent budget goes back to the tour
    key = await issueDayKey(tour, auth.row.sub);
  } catch (err) {
    let over = err instanceof HttpError && err.code === "tour_over";
    // The old key is gone and there is no new one. Say so on the record; only the owner can put it right.
    await sql`UPDATE tours SET status = ${over ? "ended" : "frozen"}, frozen_reason = ${over ? null : "a renewal could not issue the next key"} WHERE id = ${tour.id} AND current_key IS NULL`;
    await tourLedger(tour, over ? "tour-end" : "tour-freeze", tour.id, over ? "tour ran out at renewal" : "renewal failed: no key issued");
    await recordEvent(over ? "tour.ended" : "tour.frozen", { tour: tour.id, agent: tour.agent, reason: over ? "ran out" : "renewal failed" }, tour.tenant, auth.row.sub);
    throw err;
  }
  let now = nowSec();
  await sql`UPDATE tours SET current_key = ${key.row.id}, renewals = renewals + 1, last_renewed_at = ${now} WHERE id = ${tour.id}`;
  await tourLedger(tour, "tour-renew", key.row.id, `renewed: ${auth.row.id} replaced by ${key.row.id}`);
  await recordEvent("tour.renewed", { tour: tour.id, agent: tour.agent, replaced: auth.row.id, key: key.row.id }, tour.tenant, auth.row.sub);
  let row = (await sql`SELECT * FROM tours WHERE id = ${tour.id}`)[0];
  return { tour: await serializeTour(row), key: keyView(key), receipt: { tour: tour.id, replaced_key: auth.row.id, new_key: key.row.id } };
}

// REISSUE. Owner only: a fresh key for a tour whose key ran out, or one that froze.
export async function reissueTour(auth, id) {
  ownerOnly(auth);
  let tour = await ownTour(auth, id);
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  if (Number(tour.until) <= nowSec()) throw new HttpError(409, "tour_over");
  // Left alone too long, a tour is finished: the owner opens a new one (the agent's memory is under its name, so nothing is lost).
  if (tour.status === "active" && nowSec() - Number(tour.last_renewed_at) > TOUR_IDLE_END_SEC) {
    await endTourRow(tour, "idle: no renewal for too long", auth.row.sub, auth.row.id);
    throw new HttpError(409, "tour_lapsed", { idle_limit_sec: TOUR_IDLE_END_SEC });
  }
  if (tour.current_key) await revokeGrantTree(tour.current_key, "tour: key reissued by the owner", auth.row.sub);
  let key = await issueDayKey(tour, auth.row.sub),
    now = nowSec();
  await sql`UPDATE tours SET status = 'active', frozen_reason = NULL, current_key = ${key.row.id}, last_renewed_at = ${now} WHERE id = ${tour.id}`;
  await tourLedger(tour, "tour-reissue", key.row.id, `owner reissued the key${tour.status === "frozen" ? " (tour was frozen)" : ""}`, auth.row.id);
  await recordEvent("tour.reissued", { tour: tour.id, agent: tour.agent, key: key.row.id, was: tour.status }, tour.tenant, auth.row.sub);
  let row = (await sql`SELECT * FROM tours WHERE id = ${tour.id}`)[0];
  return { tour: await serializeTour(row), key: keyView(key), receipt: { tour: tour.id, reissued_by: auth.row.id, new_key: key.row.id } };
}

// EXTEND (the furlough). Owner only. More days, never more money, and never past the limits.
export async function extendTour(auth, id, body) {
  ownerOnly(auth);
  let tour = await ownTour(auth, id),
    days = plain(body).days,
    maxDays = TOUR_MAX_SIGNED_SEC / DAY,
    now = nowSec();
  if (!Number.isInteger(days) || days < 1 || days > maxDays) throw new HttpError(400, "tour_days_invalid", { min: 1, max: maxDays });
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  if (Number(tour.until) <= now) throw new HttpError(409, "tour_over", { hint: "it has already ended: open a new tour" });
  let hold = await getGrant(tour.grant_id),
    root = await getGrant(hold.parent),
    // each limit, so the answer can say which one stopped it
    limits = {
      asked: Number(tour.until) + days * DAY,
      one_signature: now + TOUR_MAX_SIGNED_SEC,
      tier: now + TIERS[auth.tenant.tier].maxTtlSec,
      whole_tour: Number(tour.opened_at) + TOUR_MAX_TOTAL_SEC,
      owner_key: Number(root.exp),
    },
    until = Math.min(...Object.values(limits));
  if (until <= Number(tour.until)) throw new HttpError(409, "tour_at_limit", { until: Number(tour.until), limits });
  let moved = await sql`UPDATE grants SET exp = ${until} WHERE id = ${tour.grant_id} AND status = 'active' AND exp > ${now} RETURNING id`;
  if (moved.length !== 1) throw new HttpError(409, "tour_over");
  await sql`UPDATE tours SET until = ${until} WHERE id = ${tour.id}`;
  await tourLedger(tour, "tour-extend", tour.id, `extended to ${new Date(until * 1000).toISOString()}`, auth.row.id);
  await recordEvent("tour.extended", { tour: tour.id, agent: tour.agent, from: Number(tour.until), until }, tour.tenant, auth.row.sub);
  let row = (await sql`SELECT * FROM tours WHERE id = ${tour.id}`)[0];
  return { tour: await serializeTour(row), receipt: { tour: tour.id, extended_by: auth.row.id, from: Number(tour.until), until, limited_by: Object.keys(limits).find((k) => limits[k] === until) } };
}

async function endTourRow(tour, reason, by, approver = null) {
  let cancelled = await revokeGrantTree(tour.grant_id, `tour: ${reason}`, by); // the holding grant and every key under it, at once
  await sql`UPDATE tours SET status = 'ended', current_key = NULL WHERE id = ${tour.id}`;
  await tourLedger(tour, "tour-end", tour.id, reason, approver);
  await recordEvent("tour.ended", { tour: tour.id, agent: tour.agent, reason, cancelled }, tour.tenant, by);
  return cancelled;
}
// END. Owner only. The kill for one agent's whole stay.
export async function endTour(auth, id) {
  ownerOnly(auth);
  let tour = await ownTour(auth, id);
  if (tour.status === "ended") throw new HttpError(409, "tour_ended");
  let cancelled = await endTourRow(tour, "ended by the owner", auth.row.sub, auth.row.id),
    row = (await sql`SELECT * FROM tours WHERE id = ${tour.id}`)[0];
  return { tour: await serializeTour(row), receipt: { tour: tour.id, ended_by: auth.row.id, cancelled_keys: cancelled.length } };
}

// LIST. The owner sees every tour of the tenant; a tour's own key sees its own tour and nothing else.
export async function listTours(auth) {
  let rows =
    Number(auth.row.depth) === 0
      ? await sql`SELECT * FROM tours WHERE tenant = ${auth.tenant.id} ORDER BY opened_at DESC LIMIT 100`
      : await sql`SELECT * FROM tours WHERE tenant = ${auth.tenant.id} AND current_key = ${auth.row.id}`;
  return Promise.all(rows.map(serializeTour));
}

// THE ALARM. verifyGrant calls this when a key that a renewal already replaced is presented again.
// Inside the grace it is a call that was in flight when the agent renewed; after it, a second copy of
// the key exists somewhere. Never throws: the caller is about to answer 401 either way.
export async function tourKeyReused(oldKey) {
  try {
    if (Date.now() - new Date(oldKey.revoked_at).getTime() <= TOUR_REUSE_GRACE_SEC * 1000) return false;
    let tour = (await sql`SELECT * FROM tours WHERE grant_id = ${oldKey.parent} AND status = 'active'`)[0];
    if (!tour) return false;
    let frozen = await sql`UPDATE tours SET status = 'frozen', frozen_reason = 'a key this tour had already replaced was used again', current_key = NULL
      WHERE id = ${tour.id} AND status = 'active' RETURNING id`;
    if (frozen.length !== 1) return false; // someone else froze it first
    if (tour.current_key) await revokeGrantTree(tour.current_key, "tour: frozen (a replaced key was used again)", "runtime");
    await tourLedger(tour, "tour-freeze", oldKey.id, `frozen: replaced key ${oldKey.id} was used again`);
    await recordEvent("tour.frozen", { tour: tour.id, agent: tour.agent, reused_key: oldKey.id, cancelled_key: tour.current_key }, tour.tenant, "runtime");
    return true;
  } catch (err) {
    console.error("ERR tour reuse alarm", err?.message || err);
    return false;
  }
}
