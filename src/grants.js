// Grant lifecycle: mint root, issue child, revoke tree, settle usage, rate limit, verify.
import { randomBytes } from "crypto";
import { POLICY_VERSION, RATE_LIMIT_MAX_PER_MIN, SERVICE_NAME } from "./config.js";
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, getTenant, isKillSwitchOn, recordEvent, sql } from "./db.js";
import { parseGrantToken, signGrantToken } from "./tokens.js";
import { AUTONOMY_LEVELS, DEFAULT_AUTONOMY, autonomyOf, lowerCheck, parseAutonomy } from "./autonomy.js";
import { hireSub, hireViolation } from "./hostpolicy.js";
import { TOUR_RENEWED, tourKeyReused } from "./tours.js";
import {
  addUsage,
  AGENT_ISSUED_MAX_TTL_SEC,
  attenuationViolations,
  CAPS,
  clampConstraints,
  holdExpiry,
  memoryPartitions,
  normalizeUsage,
  remainingBudget,
  subtractUsage,
  tenantWorkerPrefix,
  TIERS,
  usageWithin,
  zeroUsage,
} from "./policy.js";

export async function mintRootGrant(e, t = "tenant:root") {
  let a = TIERS[e.tier],
    n = nowSec(),
    r = n + a.maxTtlSec * 4,
    s = newId("gr"),
    i = parseJson(e.allowed_targets || {}),
    o = {
      v: 1,
      id: s,
      tenant: e.id,
      parent: null,
      depth: 0,
      sub: t,
      iss: SERVICE_NAME,
      iat: n,
      exp: r,
      caps: [...CAPS],
      scope: {
        railway: {
          projects: i.railway?.projects || [],
          environments: i.railway?.environments || ["production"],
        },
        workers: {
          namePrefix: tenantWorkerPrefix(e.id),
        },
        memory: {
          partitions: [""],
        },
      },
      budget: {
        usd_cents: a.usdCents,
        calls: a.deploysPerPeriod * 50,
        deploys: a.deploysPerPeriod,
      },
      constraints: {
        maxWorkers: a.maxWorkers,
        maxReplicas: a.maxReplicas,
        allowDelete: !0,
        requireDryRun: !0,
      },
      nonce: randomBytes(8).toString("hex"),
    },
    l = JSON.stringify(o);
  return (
    await sql`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
    VALUES (${s}, ${e.id}, ${null}, 0, ${t}, ${o.caps}::jsonb, ${o.scope}::jsonb,
            ${o.budget}::jsonb, ${o.constraints}::jsonb, ${l}, ${POLICY_VERSION}, ${"admin"}, ${n}, ${r})`,
    await sql`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
    VALUES (${e.id}, ${s}, ${null}, 'root', ${o.budget.usd_cents}, ${o.budget.calls}, ${o.budget.deploys}, ${s}, 'root grant minted')`,
    await recordEvent(
      "grant.issued",
      {
        id: s,
        sub: t,
        depth: 0,
      },
      e.id,
      "admin",
    ),
    {
      row: await getGrant(s),
      token: signGrantToken(l),
    }
  );
}
// o.codeWrite = { filesSha256 }: the diagnostics attestation cogExecute fetched. It is
// the only way a code.write grant is issued, and the hash is bound into the grant's
// scope (scope.code.filesSha256) so whatever honours code.write can check that the
// bytes being written are the bytes that were diagnosed.
// A lifetime must be a number. A non-number used to reach the database as NaN and answer 500.
var ttlOf = (e) => {
  let t = Number(e ?? 3600);
  if (!Number.isFinite(t)) throw Object.assign(Error("ttl_invalid"), { status: 400 });
  return t;
};
export async function issueChildGrant(e, t, a, w = {}) {
  let n = await getTenant(e.tenant);
  if (!n)
    throw Object.assign(Error("tenant_missing"), {
      status: 403,
    });
  let r = TIERS[n.tier],
    s = parseJson(e.scope),
    i = parseJson(e.constraints),
    // A key handed out BY AN AGENT (any issuer that is not the tenant's root key) lives
    // 24 hours at most, whatever the tier allows the owner (policy.js). An escrow custodian
    // (w.escrow) is not an agent being handed a key: it holds value until the deadline the
    // payer chose, so its lifetime is left alone (cutting it would refund the payer early
    // and leave a later, valid delivery unpaid).
    o = Math.min(Math.max(60, Math.floor(ttlOf(t.ttlSec))), r.maxTtlSec, Number(e.depth) >= 1 && !w?.escrow ? AGENT_ISSUED_MAX_TTL_SEC : Infinity),
    l = nowSec(),
    c = Math.min(l + o, Number(e.exp));
  // A payment hold that asked for a time (w.heldUntil, from openEscrow) ends at exactly that
  // time and is never cut short. buildEscrow has already refused a time past the payer key's
  // end or the tier's longest lifetime, but it read the tier before this function did. This is
  // the last word, on the tier (`r`) and the clock (`l`) read just above: if the tier moved in
  // between, the hold is refused here, not shortened. Only openEscrow sets heldUntil, always
  // to a whole number (0 = nothing asked); anything unreadable is treated as nothing asked.
  let heldUntil = w?.escrow ? Number(w.heldUntil) || 0 : 0;
  if (heldUntil) {
    let limit = Math.min(l + r.maxTtlSec, Number(e.exp)),
      end = holdExpiry(heldUntil, l, limit);
    if (end === null)
      throw Number(e.exp) < heldUntil
        ? new HttpError(409, "escrow_deadline_exceeds_payer_key", { payer_exp: Number(e.exp) })
        : new HttpError(409, "escrow_deadline_exceeds_tier_max", { max_ttl_sec: r.maxTtlSec, latest_deadline: limit });
    c = end;
  }
  let E = {
      railway: {
        projects: t.scope?.railway?.projects ?? s.railway?.projects ?? [],
        environments: t.scope?.railway?.environments ?? s.railway?.environments ?? [],
      },
      workers: {
        namePrefix: t.scope?.workers?.namePrefix ?? s.workers?.namePrefix ?? "",
      },
      memory: {
        partitions: t.scope?.memory?.partitions ?? memoryPartitions(s),
      },
      // a worker-template allow-list. A child inherits the parent's list when it
      // omits one (fail-closed inheritance); absent entirely == wildcard, so every
      // existing grant is unaffected. attenuationViolations enforces it as a ceiling.
      ...(Array.isArray(t.scope?.templates ?? s.templates)
        ? { templates: [...new Set((t.scope?.templates ?? s.templates).map(String))] }
        : {}),
      ...(w?.codeWrite?.filesSha256 ? { code: { filesSha256: String(w.codeWrite.filesSha256) } } : {}),
      // escrow keystone: a validated escrow resolution block rides in scope. It is a
      // data annotation, not authority (attenuationViolations ignores it and the
      // custodian's only cap is the no-op escrow.hold), so it never widens the child.
      ...(w?.escrow ? { escrow: w.escrow } : {}),
      // tours (tours.js): the mark on a tour's HOLDING grant. Like escrow it is an annotation, not
      // authority; it is how verifyGrant knows this grant is a record and never a credential.
      ...(w?.tour ? { tour: w.tour } : {}),
    },
    T = normalizeUsage(t.budget ?? zeroUsage()),
    R = clampConstraints(t.constraints ?? {}, i),
    S = {
      caps: [...new Set(t.caps || [])],
      scope: E,
      budget: T,
      exp: c,
      constraints: R,
      depth: Number(e.depth) + 1,
    },
    B = attenuationViolations(e, S, n.tier, w);
  if (B.length)
    throw Object.assign(Error("attenuation_violation"), {
      status: 403,
      detail: B,
    });
  // Agent-host (hostpolicy.js). The host grant itself carries its ceilings; a hire
  // anywhere below a host is checked against them and renamed agent:<host>/<role>.
  // An escrow custodian is not a hire, so it is exempt.
  if (w?.host) R.host = w.host;
  let hireName = null;
  if (!w?.host && !w?.escrow) {
    let host = await hostAbove(e.id);
    if (host) {
      let fault = hireViolation(parseJson(host.constraints).host, {
        hostDepth: Number(host.depth),
        childDepth: S.depth,
        liveBelow: await liveBelowHost(host.id),
      });
      if (fault) {
        await recordAutonomyRow(e, "host-refused", host.id, `hire under ${host.sub} refused: ${fault}`, { decision: "refuse" });
        throw Object.assign(Error("attenuation_violation"), { status: 403, detail: [fault] });
      }
      hireName = hireSub(host.id, t.sub);
    }
  }
  let $ = newId("gr"),
    C = {
      v: 1,
      id: $,
      tenant: n.id,
      parent: e.id,
      depth: S.depth,
      sub: hireName || String(t.sub || "agent:anon").slice(0, 80),
      iss: SERVICE_NAME,
      iat: l,
      exp: c,
      caps: S.caps,
      scope: E,
      budget: T,
      constraints: R,
      nonce: randomBytes(8).toString("hex"),
    },
    pe = JSON.stringify(C);
  return (
    await sql.begin(async (H) => {
      let P = (await H`SELECT * FROM grants WHERE id = ${e.id} FOR UPDATE`)[0];
      // This check, made while the parent is locked, is what revokeGrantTree leans on: once it has moved a grant
      // from active, nothing more can be issued under that grant. (endedAbove: nor under one that hangs from a
      // grant that has ended.)
      if (!P || P.status !== "active" || (await endedAbove(H, P.id)))
        throw Object.assign(Error("parent_not_active"), {
          status: 403,
        });
      if (!usageWithin(T, remainingBudget(P)))
        throw Object.assign(Error("budget_exceeds_parent_remaining"), {
          status: 402,
        });
      let ee = addUsage(normalizeUsage(parseJson(P.reserved)), T);
      (await H`UPDATE grants SET reserved = ${ee}::jsonb WHERE id = ${e.id}`,
        await H`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
      VALUES (${$}, ${n.id}, ${e.id}, ${S.depth}, ${C.sub}, ${S.caps}::jsonb, ${E}::jsonb,
              ${T}::jsonb, ${R}::jsonb, ${pe}, ${POLICY_VERSION}, ${a}, ${l}, ${c})`,
        await H`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${n.id}, ${$}, ${e.id}, 'reserve', ${T.usd_cents}, ${T.calls}, ${T.deploys}, ${$}, ${"reserved for " + C.sub})`);
    }),
    await recordEvent(
      "grant.issued",
      {
        id: $,
        parent: e.id,
        sub: C.sub,
        depth: S.depth,
        caps: S.caps,
      },
      n.id,
      a,
    ),
    {
      row: await getGrant($),
      token: signGrantToken(pe),
    }
  );
}
// What a grant has NOT used, which is what goes back to its parent when it ends: what it was given, less
// what it settled itself, less what is still held on it for the keys under it. Once those keys have
// ended, what is still held IS what they used. So a key's spend counts against every grant above it, all
// the way up. (Before 2026-10-09 the last term was missing: spend two levels down was forgotten the
// moment the grant in between ended, and the grant above got its whole budget back.)
function unusedOf(g, heldNow) {
  let u = subtractUsage(subtractUsage(normalizeUsage(parseJson(g.budget)), normalizeUsage(parseJson(g.settled))), normalizeUsage(parseJson(heldNow)));
  return { usd_cents: Math.max(0, u.usd_cents), calls: Math.max(0, u.calls), deploys: Math.max(0, u.deploys) };
}
// DEFENCE IN DEPTH: a grant is only as alive as everything above it. Cancelling a grant cancels everything under
// it (revokeGrantTree), and a grant that runs out waits for the keys under it, so an ACTIVE grant under one that
// has ended is not a state this code means to leave. Where one exists it must not work. Three ways one can exist:
// a row left by the gap revokeGrantTree had until 2026-10-09; a hold opened with another hold's own token before
// buildEscrow refused a hold as payer (the same day), once the hold above it has ended; a mistake still to be made.
// "Ended" is any status but active: cancelled, run out, captured.
//
// WHO LOOKS: verifyGrant (every request that carries a key), settleGrantUsage, issueChildGrant, the owner's
// approval of a request the grant filed (routes/grants.js), the OAuth refresh and the admin's token reissue
// (neither hands out a fresh token for it). WHO DOES NOT: captureEscrow, on purpose. A hold under an ended grant
// can still be captured on a signed delivery receipt; see the note there.
//
// ONE walk, used by all of them: grantAndChain reads a grant's row and, in the SAME statement, whether any grant
// above it has ended. The walk goes up the parent chain, one primary-key look-up per step and at most as many
// steps as the tier's maxDepth (6 today). `parent` is written once, when a row is made, and points at a row that
// already exists, so the chain cannot loop. On the verify path this is the read verifyGrant made anyway, so the
// walk costs no extra round trip to the database. `q` is what to read with: the write paths pass their own
// transaction, so that they look AFTER they hold their own row's lock.
async function grantAndChain(q, id) {
  let row = (
    await q`WITH RECURSIVE up AS (SELECT p.id, p.parent, p.status FROM grants c JOIN grants p ON p.id = c.parent WHERE c.id = ${id}
        UNION ALL SELECT p.id, p.parent, p.status FROM grants p JOIN up ON p.id = up.parent)
      SELECT g.*, (SELECT up.id FROM up WHERE up.status <> 'active' LIMIT 1) AS ended_above FROM grants g WHERE g.id = ${id}`
  )[0];
  if (!row) return { row: null, endedAbove: null };
  let { ended_above, ...grant } = row;
  return { row: grant, endedAbove: ended_above ?? null };
}
// The id of an ended grant above `id`, or null.
export async function endedAbove(q, id) {
  return (await grantAndChain(q, id)).endedAbove;
}
// When two transactions each hold a row the other wants, Postgres ends the wait after about a second by
// aborting ONE of them (SQLSTATE 40P01, "deadlock detected"); everything that one had done is rolled back.
// Bun.SQL carries the SQLSTATE in `errno`.
const isDeadlock = (err) => String(err?.errno ?? err?.code ?? "") === "40P01" || /deadlock detected/i.test(String(err?.message || ""));
// How often a cancel is tried in all when it keeps losing such a wait. Each lost try costs about a second.
const CANCEL_TRIES = 3;
// Cancel a grant and everything under it. Answers the ids it really moved from active, lower ones first.
//
// EVERYTHING UNDER IT, including what is written while this runs. The list read at the start locks nothing (the
// FOR UPDATE that used to sit on it was on a WITH query, which Postgres does not lock), so a child can be issued
// under a grant after the list was read and before that grant is taken. Until 2026-10-09 such a child was missed:
// it stayed live under a cancelled parent and its whole budget stayed held on the grant above for good. Now each
// grant is taken in ONE statement, and from that moment nothing can be issued under it: issueChildGrant locks its
// parent and refuses one that is not active, so it either finished before the grant was taken or is refused after.
// So right after taking a grant its active children are listed AGAIN, each is cancelled the same way (and its
// children, and so on down), and only then is what is held on the grant read for its own release.
// ONE LIMIT: that second look goes down through ACTIVE children only. A key under a child that was written and
// ALSO ended while this ran is not reached. That takes a writer that ends a grant while something under it is
// still active, and none does: the sweep and a capture wait until nothing is, and another cancel makes this
// same look. (Until 2026-10-09 a capture did not wait, and a hold could open a hold under itself.)
// (This leans on READ COMMITTED, the level Postgres runs at unless told otherwise and the one this service uses:
// each statement sees everything committed before it began, so the second look sees a key whose issue finished
// while the statement before it was waiting for the parent's lock.)
//
// LOCKS. Inside its one transaction this holds a grant, and the parent it released into, while it asks for the
// next one: the next sibling, or a child found by the second look. Every other transaction that takes two grants
// (the sweep and the lazy release below, captureEscrow) takes a child and then its parent. So this and one of
// those, or two cancels over the same grants, can each end up holding what the other wants. (So can this and
// lowerGrantAutonomy, whose one UPDATE takes a subtree's rows in no promised order.) Postgres aborts one side; no
// balance moves, because that side's whole transaction is undone. When the side aborted is this one it simply
// starts again: nothing of the failed try is left, the list is read afresh and a grant that somebody else ended
// in the meantime is not moved again (it is still looked under). The fixed order (depth, then id) keeps two cancels that both LISTED the same two
// grants of one depth from taking them in opposite orders. It does not rule the other cycles out (not even that
// one, when one of the two cancels finds a grant only by its second look); the retry is what covers those.
export async function revokeGrantTree(e, t, a) {
  let n = [];
  for (let attempt = 1; ; attempt++) {
    n = [];
    try {
      await sql.begin(async (r) => {
        const cancel = async (id) => {
          // Only the caller that really moves the row from active lets it go (a sweep may have got there first:
          // never release twice), and what it gives back is worked out from the row AS IT IS NOW (a settle may have
          // landed, and the grants under it have let go, since the list was read).
          let i = (await r`UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = ${t} WHERE id = ${id} AND status = 'active' RETURNING *`)[0];
          // The second look: children issued since the list was read. Nothing can be added under this grant now.
          // It is made ALSO when this call did not move the grant, because somebody else ended it first. Every
          // writer that ends a grant means to leave nothing active under it (the sweep and a capture wait until
          // nothing is; another cancel makes this same look), so this finds something only if one of them ever
          // does not. Either way the grant is no longer active, so nothing more can be issued under it and one
          // look is enough.
          let late = await r`SELECT id FROM grants WHERE parent = ${id} AND status = 'active' ORDER BY id`;
          for (let child of late) await cancel(child.id);
          if (!i) return; // not this call's to let go
          // What is held on it. This transaction has had the row locked since the statement above, so the only
          // thing that can have changed it since is a release made just now by one of those late children.
          let held = late.length ? (await r`SELECT reserved FROM grants WHERE id = ${id}`)[0].reserved : i.reserved,
            o = unusedOf(i, held);
          if (i.parent) {
            let l = (await r`SELECT reserved FROM grants WHERE id = ${i.parent} FOR UPDATE`)[0],
              c = subtractUsage(normalizeUsage(parseJson(l.reserved)), o);
            (await r`UPDATE grants SET reserved = ${{
              usd_cents: Math.max(0, c.usd_cents),
              calls: Math.max(0, c.calls),
              deploys: Math.max(0, c.deploys),
            }}::jsonb WHERE id = ${i.parent}`,
              await r`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
            VALUES (${i.tenant}, ${i.id}, ${i.parent}, 'release', ${o.usd_cents}, ${o.calls}, ${o.deploys}, ${i.id}, ${t})`);
          }
          n.push(i.id);
        };
        // Deepest first, so that by the time a grant is reached everything under it that was in this list has let
        // go. The list walks down through grants of any status, so an active grant under one that has already
        // ended is cancelled too.
        let s = await r`WITH RECURSIVE sub AS (SELECT id, depth FROM grants WHERE id = ${e}
        UNION ALL SELECT g.id, g.depth FROM grants g JOIN sub ON g.parent = sub.id) SELECT id FROM sub ORDER BY depth DESC, id`;
        for (let { id } of s) await cancel(id);
      });
      break;
    } catch (err) {
      if (!isDeadlock(err) || attempt >= CANCEL_TRIES) throw err;
      await new Promise((go) => setTimeout(go, 15 * attempt + Math.random() * 25)); // let the other side finish
    }
  }
  if (n.length) {
    let r = await getGrant(e);
    await recordEvent(
      "grant.revoked",
      {
        ids: n,
        reason: t,
      },
      r?.tenant || null,
      a,
    );
  }
  return n;
}
// `k` is the ledger kind: 'settle' for charges the runtime itself makes (deploys),
// 'self-settle' for a holder settling its own grant via POST /api/grants/settle,
// so the two can never be confused in the ledger.
// `m` carries the autonomy dial's record for the charge: { autonomy, decision, approver }.
export async function settleGrantUsage(e, t, a, n, k = "settle", m = {}) {
  await sql.begin(async (r) => {
    let s = (await r`SELECT * FROM grants WHERE id = ${e} FOR UPDATE`)[0];
    // (endedAbove: nor does a grant settle when one above it has ended.)
    if (!s || s.status !== "active" || (await endedAbove(r, s.id)))
      throw Object.assign(Error("grant_not_active"), {
        status: 401,
      });
    if (!usageWithin(t, remainingBudget(s)))
      throw Object.assign(Error("budget_exhausted"), {
        status: 402,
      });
    (await r`UPDATE grants SET settled = ${addUsage(normalizeUsage(parseJson(s.settled)), t)}::jsonb WHERE id = ${e}`,
      await r`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note, autonomy, decision, approver)
      VALUES (${s.tenant}, ${e}, ${s.parent}, ${k}, ${t.usd_cents}, ${t.calls}, ${t.deploys}, ${a}, ${n},
              ${m.autonomy ?? null}, ${m.decision ?? null}, ${m.approver ?? null})`);
  });
}
// The nearest agent-host at or above a grant (the grant whose constraints carry
// `host`), or null. Walks up the parent chain.
export async function hostAbove(grantId) {
  return (
    await sql`WITH RECURSIVE up AS (SELECT * FROM grants WHERE id = ${grantId}
        UNION ALL SELECT g.* FROM grants g JOIN up ON g.id = up.parent)
      SELECT * FROM up WHERE constraints->'host' IS NOT NULL ORDER BY depth DESC LIMIT 1`
  )[0] || null;
}
// A host's live hires: active, unexpired grants anywhere below it.
export async function liveBelowHost(hostId) {
  return (
    await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE parent = ${hostId}
        UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
      SELECT count(*)::int AS n FROM grants WHERE id IN (SELECT id FROM sub) AND status = 'active' AND exp > ${nowSec()}`
  )[0].n;
}
// A zero-amount ledger row that records what the autonomy dial did with a value
// action that did NOT settle: asked a human (autonomy-ask), was refused
// (autonomy-refused), was denied (autonomy-denied) or had the dial lowered
// (autonomy-set). Refusals are recorded, never swallowed.
export async function recordAutonomyRow(row, kind, ref, note, m = {}) {
  await sql`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note, autonomy, decision, approver)
    VALUES (${row.tenant}, ${row.id}, ${row.parent}, ${kind}, 0, 0, 0, ${ref}, ${String(note).slice(0, 200)},
            ${m.autonomy ?? null}, ${m.decision ?? null}, ${m.approver ?? null})`;
}
// Turn a grant's dial DOWN (never up — raising takes a new grant from the issuer).
// Cascades: every descendant above the new level comes down with it, so the
// child <= parent invariant holds for the whole subtree. The caller must be the
// target itself or an ancestor of it.
export async function lowerGrantAutonomy(caller, targetId, level) {
  let t = await getGrant(targetId);
  if (!t || t.tenant !== caller.tenant) throw new HttpError(404, "grant_not_found");
  let inSubtree =
    await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${caller.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
    SELECT 1 FROM sub WHERE id = ${targetId} LIMIT 1`;
  if (!inSubtree.length) throw new HttpError(403, "not_in_your_subtree");
  let current = autonomyOf(parseJson(t.constraints)),
    fault = lowerCheck(current, level);
  if (fault) throw new HttpError(fault === "autonomy_invalid" ? 400 : 403, fault, { current, levels: AUTONOMY_LEVELS });
  let next = parseAutonomy(level),
    changed =
      await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${targetId} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
      UPDATE grants SET constraints = jsonb_set(constraints, '{autonomy}', to_jsonb(${next}::int))
      WHERE id IN (SELECT id FROM sub) AND COALESCE((constraints->>'autonomy')::int, ${DEFAULT_AUTONOMY}) > ${next}
      RETURNING id`;
  await recordAutonomyRow(t, "autonomy-set", targetId, `dial lowered to ${AUTONOMY_LEVELS[next]} by ${caller.sub}`, {
    autonomy: next,
    decision: "lowered",
    approver: caller.id,
  });
  await recordEvent("grant.autonomy_lowered", { id: targetId, from: current, to: next, cascaded: changed.length }, t.tenant, caller.sub);
  return { id: targetId, from: AUTONOMY_LEVELS[current], to: AUTONOMY_LEVELS[next], grantsChanged: changed.length };
}
// Release a grant's UNUSED reservation (unusedOf: budget - settled - what is still held on it for the keys
// under it; the same amount revokeGrantTree computes) back to its parent when it transitions active->expired.
// The `RETURNING` row-count guard is the idempotency lever: only the call that
// actually flips the row releases, so a second sweep, the lazy verify path, and a
// later revoke can never double-credit the parent. Mirrors revokeGrantTree's
// release (same math, same 'release' ledger row).
async function releaseExpiredGrant(tx, g) {
  // A grant lets go only AFTER everything under it has. Until then what is held on it is not yet "what the keys
  // under it used", so it waits: the sweep goes deepest first, and a child never outlives its parent, so anything
  // still active under an expired grant is itself due for the sweep (this pass, or the next if another writer held
  // it). This only LOOKS at the children; it never locks one. The transaction holds one grant and then its parent
  // and nothing else: child, then parent. (revokeGrantTree holds a parent while it asks for one of that parent's
  // children, so this and a cancel can each hold what the other wants. Postgres then aborts one of the two
  // without changing any balance: see the notes above revokeGrantTree and reapExpiredGrants.)
  let waiting = await tx`SELECT 1 FROM grants WHERE parent = ${g.id} AND status = 'active' LIMIT 1`;
  if (waiting.length) return !1;
  let flipped = await tx`UPDATE grants SET status='expired' WHERE id = ${g.id} AND status='active' RETURNING reserved`;
  if (flipped.length !== 1) return !1; // someone else already moved it (revoked/expired) — never double-release
  if (!g.parent) return !0; // a root holds no reservation upward
  let unspent = unusedOf(g, flipped[0].reserved),
    p = (await tx`SELECT reserved FROM grants WHERE id = ${g.parent} FOR UPDATE`)[0];
  if (p) {
    let c = subtractUsage(normalizeUsage(parseJson(p.reserved)), unspent);
    (await tx`UPDATE grants SET reserved = ${{
      usd_cents: Math.max(0, c.usd_cents),
      calls: Math.max(0, c.calls),
      deploys: Math.max(0, c.deploys),
    }}::jsonb WHERE id = ${g.parent}`,
      await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${g.tenant}, ${g.id}, ${g.parent}, 'release', ${unspent.usd_cents}, ${unspent.calls}, ${unspent.deploys}, ${g.id}, 'reservation released on expiry')`);
  }
  return !0;
}
// The periodic sweep that actually cures the drain: the dominant leak is ABANDONED
// grants (guest/OAuth children that never present a token again), for which the
// lazy release-on-verify below never fires.
//
// ONE GRANT PER TRANSACTION, never a batch (deadlock fix, review 2026-09-27). The
// earlier version held ONE transaction that skip-locked a whole batch of expired
// children (from unrelated subtrees) and THEN reached for each child's parent with
// a blocking `FOR UPDATE`. That wide held-set — many children at once, parents still
// wanted — could cycle against a concurrent revokeGrantTree / settleGrantUsage /
// issueChildGrant, or a second replica's sweep, and Postgres would abort one side on
// a real deadlock. Now: an UNLOCKED candidate scan (deepest first, so a child is
// released before its parent), then each release in its OWN txn that locks the child
// then its parent. A single-grant txn's lock footprint is one grant + its parent, and
// a wait-for cycle among such txns alone would require a cycle in the parent pointers,
// which a tree has none of. The lazy release in verifyGrant and captureEscrow take the
// same two rows in the same order, and issueChildGrant and settleGrantUsage take one
// row only, so none of those can cycle with a sweep txn.
//
// TWO WRITERS ARE DIFFERENT (corrected 2026-10-09; this note used to say that no writer
// holds a parent while requesting its child):
//   - revokeGrantTree: in its one txn it holds the parent it has just released into
//     while it asks for the next sibling, or for a child issued while it ran;
//   - lowerGrantAutonomy: its one UPDATE over a subtree takes those rows one after
//     another, in no promised order.
// So one of them can hold a parent and want child 2 while a sweep txn holds child 2
// and wants that parent. They wait on each other until Postgres aborts one (40P01,
// after about a second). No balance moves: the aborted txn is rolled back whole. A
// cancel that is aborted tries again (revokeGrantTree); a dial-lowering that is
// aborted fails that one request. If a sweep txn is the one aborted, that ONE
// candidate is left for the next pass: each candidate is caught on its own below, so
// one failure no longer ends the pass and leaves every later candidate waiting a
// further minute.
//
// ANY failure of one candidate is caught, not only a lost lock wait: a candidate that
// can never be released must not hold up every one after it, pass after pass (there
// is no "stop after so many" for the same reason). It is not hidden: the pass says
// what it left, in ONE log line, and in `failed` for a caller that passes a list (the
// admin route puts it in its answer).
export async function reapExpiredGrants({ limit = 500, failed = [] } = {}) {
  let candidates = await sql`SELECT id FROM grants WHERE status='active' AND exp <= ${nowSec()} ORDER BY depth DESC LIMIT ${limit}`,
    ids = [];
  for (let { id } of candidates) {
    try {
      // Re-check status/exp UNDER the lock — the candidate scan was unlocked, so the
      // row may have been revoked/settled/re-issued since. SKIP LOCKED (not a blocking
      // wait): if another writer already holds this row, skip it this pass — the next
      // sweep catches it, or that writer releases it — rather than queue behind them.
      let reaped = await sql.begin(async (tx) => {
        let g = (
          await tx`SELECT * FROM grants WHERE id = ${id} AND status='active' AND exp <= ${nowSec()} FOR UPDATE SKIP LOCKED`
        )[0];
        return g ? await releaseExpiredGrant(tx, g) : !1;
      });
      if (reaped) ids.push(id);
    } catch (err) {
      // Nothing of this candidate's txn is left, so it is exactly as it was: still due, taken by the next pass. A
      // grant above it in this pass sees it still active and waits for it (releaseExpiredGrant).
      failed.push({ id, error: String(err?.message || err).slice(0, 200) });
    }
  }
  if (failed.length) console.error(`[reaper] ${failed.length} of ${candidates.length} left for the next pass; the first: ${failed[0].id} (${failed[0].error})`);
  if (ids.length) await recordEvent("grant.reaped", { ids }, null, "reaper");
  return ids;
}
// Postgres-backed (fixed 60s window keyed by grant id), not a process-local
// Map: the runtime scales to multiple replicas and a replica-local bucket let
// each replica give the same grant its own fresh budget (2026-09-25 fix).
// The fixed-60s-window limiter, keyed by an arbitrary string — the grant id for
// the generic per-grant limit, or a namespaced key like `mw:<grant>` for the
// guest memory-write meter. Returns true while under `max`.
export async function checkNamedRateLimit(key, max) {
  let t = Math.floor(Date.now() / 60000) * 60000,
    a = (
      await sql`INSERT INTO rate_limits (grant_id, window_start, count) VALUES (${key}, ${t}, 1)
      ON CONFLICT (grant_id, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`
    )[0];
  if (Math.random() < 0.01) await sql`DELETE FROM rate_limits WHERE window_start < ${t - 300000}`;
  return a.count <= max;
}
async function checkRateLimit(e) {
  return checkNamedRateLimit(e, RATE_LIMIT_MAX_PER_MIN);
}
export async function verifyGrant(e, t, a, countRate = !0) {
  try {
    if (!e) throw new HttpError(401, "missing_grant");
    let n = parseGrantToken(e);
    if (!n) throw new HttpError(401, "bad_grant");
    let r = n.payload;
    if (Number(r.exp) <= nowSec()) {
      // lazy release: a re-presented expired token frees its reservation now, via
      // the SAME helper the sweep uses (idempotent — the RETURNING guard means the
      // sweep won't release it again). If a key under it is still waiting for the
      // sweep, nothing is freed here: the sweep takes both, lower one first.
      await sql.begin(async (tx) => {
        let g = (await tx`SELECT * FROM grants WHERE id = ${r.id} FOR UPDATE`)[0];
        // The ROW's end decides, not the token's: a tour's holding grant can be extended after its token text
        // was written (tours.js), and an old token for it must not end it early.
        if (g && Number(g.exp) <= nowSec()) await releaseExpiredGrant(tx, g);
      });
      throw new HttpError(401, "grant_expired");
    }
    let { row: s, endedAbove: above } = await grantAndChain(sql, r.id);
    // A key that a tour renewal already replaced, presented again: the alarm (tours.js). It answers 401 either way.
    if (s && s.status === "revoked" && s.revoke_reason === TOUR_RENEWED) await tourKeyReused(s);
    if (!s || s.status !== "active") throw new HttpError(401, "grant_revoked");
    // Active itself, but a grant above it has ended: as dead as if it had been cancelled with it (endedAbove).
    if (above) throw new HttpError(401, "grant_revoked", { why: "a grant above this one has ended" });
    // A tour's holding grant is a record, never a credential, whoever came to hold a token for it.
    if (parseJson(s.scope)?.tour?.holder) throw new HttpError(401, "holding_grant");
    let i = await getTenant(s.tenant);
    if (!i || i.status !== "active") throw new HttpError(403, "tenant_suspended");
    if (await isKillSwitchOn()) throw new HttpError(503, "runtime_paused");
    let o = parseJson(s.caps);
    if (t && !o.includes(t))
      throw new HttpError(403, "missing_cap", {
        need: t,
      });
    if (a) {
      let l = parseJson(s.scope);
      if (a.project && !(l.railway?.projects || []).includes(a.project))
        throw new HttpError(403, "out_of_scope", {
          project: a.project,
        });
      if (a.environment && !(l.railway?.environments || []).includes(a.environment))
        throw new HttpError(403, "out_of_scope", {
          environment: a.environment,
        });
      if (a.workerName && !a.workerName.startsWith(l.workers?.namePrefix || "\x00"))
        throw new HttpError(403, "out_of_scope", {
          workerName: a.workerName,
        });
    }
    if (countRate && !(await checkRateLimit(s.id))) throw new HttpError(429, "rate_limited");
    return {
      row: s,
      tenant: i,
      payload: r,
      // 0.3.2: the presented token travels with the auth so the COG can present it
      // to lsp-mcp on the caller's behalf (lsp-mcp introspects it back here).
      token: e,
    };
  } catch (n) {
    if (n instanceof HttpError) throw n;
    throw new HttpError(403, "verification_error");
  }
}
