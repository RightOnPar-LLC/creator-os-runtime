// Escrow keystone (stage 1: open + read). An escrow is NOT a new value engine — it is a
// child grant held by a neutral custodian. The HOLD is issueChildGrant's reserve (the payer's
// value is parked, unspendable); the REFUND is the reaper / revokeGrantTree release-on-expiry.
// CAPTURE (resolving held value to the payee on a verified condition) is stage 2 and lives
// nowhere yet. See docs/specs/escrow-keystone.md.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, getTenant, recordEvent, sql } from "./db.js";
import { addUsage, normalizeUsage, subtractUsage, TIERS } from "./policy.js";
import { issueChildGrant } from "./grants.js";

// Stage 1 accepts only MESH (closed-loop). A `usd` (real-money, withdrawable) capture would be
// money-out — a hard floor behind the legal envelope — so a usd escrow is refused at the door,
// not merely blocked at capture. Widen this set only when that legal structure exists.
export const ESCROW_DENOMS = ["mesh"];
// The condition kinds a capture (stage 2) will resolve against. Validated at open so an escrow
// can never be created carrying a condition nothing can ever satisfy.
export const ESCROW_CONDITION_KINDS = ["attestation:self-settle", "receipt:mesh"];
export const ESCROW_CUSTODY_CAP = "escrow.hold";

// A JSON number, or a string that reads as one. Number() alone would also read true as 1 and
// "", false and [] as 0, so those are not numbers here.
var numberFrom = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);

// Is this grant a hold? Any `escrow` mark in its scope counts, whatever its shape (issueChildGrant
// only ever writes an object there; a mark that was damaged must still read as a hold, so that a
// hold is never taken for an ordinary key).
var isHold = (grantRow) => {
  let scope = parseJson(grantRow?.scope);
  return !!scope && typeof scope === "object" && scope.escrow !== undefined;
};

// Validate the open request and shape the custodian child spec + the scope.escrow block.
// Throws HttpError on any bad input; never partially opens. `tier` is the payer tenant's tier.
export function buildEscrow(payerRow, params, tier) {
  // A hold cannot pay for another hold. POST /api/escrow hands the custodian's token back to
  // the payer, and the custodian's one capability (escrow.hold, a marker) is the same one that
  // route asks for. Without this check that token could pledge the held value a second time:
  // two holds, two captures, two credits, one payment.
  if (isHold(payerRow)) throw new HttpError(403, "escrow_custodian_cannot_pay");
  let p = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  // amount: MESH-denominated commit, carried in usd_cents (the model's value slot). > 0.
  let amount = Math.floor(Number(p.amount ?? p.usd_cents ?? 0));
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "escrow_amount_required");
  let denom = String(p.denom ?? "mesh");
  if (denom === "usd") throw new HttpError(403, "escrow_usd_gated", { needs: "legal_envelope" });
  if (!ESCROW_DENOMS.includes(denom)) throw new HttpError(400, "escrow_denom_unknown", { denom, allowed: ESCROW_DENOMS });
  let payeeTenant = String(p.payee_tenant ?? "").slice(0, 80);
  if (!payeeTenant) throw new HttpError(400, "escrow_payee_tenant_required");
  let payeeRef = p.payee_ref != null ? String(p.payee_ref).slice(0, 120) : null;
  let kind = String(p.condition?.kind ?? "");
  if (!ESCROW_CONDITION_KINDS.includes(kind))
    throw new HttpError(400, "escrow_condition_unknown", { kind, allowed: ESCROW_CONDITION_KINDS });
  let conditionRef = p.condition?.ref != null ? String(p.condition.ref).slice(0, 200) : null;
  // How long the hold lasts. The payer gives `deadline` (unix seconds) or `ttlSec`; with both,
  // the deadline wins. `deadline` absent, null or the number 0 means "not given". Anything else
  // must be a time later than now, and a `ttlSec` that is given must be a number, or the open is
  // refused here, before a hold is opened or an approval is filed for the owner. A deadline
  // that could not be read, or had already passed, used to fall back to the default hour and
  // answer 201: a hold the payer never asked for.
  // With nothing asked the hold lasts an hour. That default is not a promise: issueChildGrant
  // still ends it at the payer key's own end and at the tier's longest lifetime, whichever
  // comes first, and the answer carries the deadline it really got. A time that WAS asked for
  // is never cut short: the hold ends at exactly that time or the open is refused, here and
  // again where the end is written (holdExpiry in issueChildGrant). Times are whole seconds (a
  // fraction is dropped). A time less than a minute away when the hold is written ends later
  // than asked: at the minute every key gets, or at the payer key's end if that comes first.
  let now = nowSec();
  let deadline = 0;
  if (p.deadline != null && p.deadline !== 0) {
    deadline = Math.floor(numberFrom(p.deadline));
    if (!(Number.isFinite(deadline) && deadline > now))
      throw new HttpError(400, "escrow_deadline_invalid", { now, hint: "unix seconds, later than now" });
  }
  let ttlAsked = p.ttlSec == null ? null : Math.floor(numberFrom(p.ttlSec));
  if (ttlAsked !== null && !Number.isFinite(ttlAsked)) throw new HttpError(400, "ttl_invalid");
  let ttlSec = deadline ? deadline - now : (ttlAsked ?? 3600);
  // A hold never outlives the key that pays for it (a child never outlives its parent). When
  // the payer ASKS for a deadline past its own key's end, refuse and say why: quietly cutting
  // it would refund the payer early and leave a later, valid delivery unpaid. A key an agent
  // was handed lives a day at most (policy.js), so a longer hold needs a longer-lived payer.
  // Written to fail closed: if the payer key's end is not a real time still ahead of us (it
  // cannot be read as a number, or reads as nothing), nothing opens, asked or not. With
  // nothing asked, `asked` is 0 and passes a readable key.
  let payerExp = Number(payerRow.exp);
  let asked = deadline ? deadline : ttlAsked !== null ? now + ttlAsked : 0;
  if (!(Number.isFinite(payerExp) && payerExp > now && asked <= payerExp))
    throw new HttpError(409, "escrow_deadline_exceeds_payer_key", { payer_exp: payerExp });
  // The tier's longest lifetime is the other limit issueChildGrant would cut a hold to, so an
  // asked-for time past it is refused for the same reason. In practice only the owner's own key
  // can ask for one (every other key already ends within the tier's longest lifetime), or a key
  // that outlived a move to a smaller tier. Nothing opens under a tier that is not in TIERS,
  // asked or not. `latest_deadline` is the latest time this key can ask for right now, both
  // limits counted.
  let tierMax = Number(TIERS[tier]?.maxTtlSec);
  if (!(Number.isFinite(tierMax) && tierMax > 0)) throw new HttpError(403, "unknown_tier");
  if (asked - now > tierMax)
    throw new HttpError(409, "escrow_deadline_exceeds_tier_max", { max_ttl_sec: tierMax, latest_deadline: Math.min(payerExp, now + tierMax) });
  let escrowId = newId("es");
  let escrow = {
    escrow_id: escrowId,
    payer_grant: payerRow.id,
    payee_tenant: payeeTenant,
    payee_ref: payeeRef,
    denom,
    condition: { kind, ref: conditionRef },
    on_success: "capture",
    on_deadline: "refund",
    opened_at: now,
  };
  let childSpec = {
    sub: ("escrow:" + (payeeRef || payeeTenant)).slice(0, 80),
    caps: [ESCROW_CUSTODY_CAP], // no-op marker; satisfies the no_caps floor, grants nothing
    ttlSec,
    budget: { usd_cents: amount, calls: 0, deploys: 0 },
    scope: { memory: { partitions: [] } }, // custodian holds no memory; caps make scope inert anyway
  };
  // `until` is the time the payer asked for (0 when nothing was asked). openEscrow hands it to
  // issueChildGrant, which ends the hold at exactly that time.
  return { childSpec, escrow, until: asked };
}

// Open = issue the custodian child. The reserve inside issueChildGrant IS the hold: the payer's
// remaining drops by `amount` and it can no longer spend that value elsewhere. Returns the same
// {row, token} shape as issueChildGrant.
export async function openEscrow(payerRow, params, issuedBy) {
  // The tier is read here, not passed in, so the approvals path is checked against the tier
  // the tenant is on when the owner approves. issueChildGrant reads the tenant once more and
  // has the last word (heldUntil): if the tier moved between the two reads, it refuses.
  let tenant = await getTenant(payerRow.tenant);
  if (!tenant) throw new HttpError(403, "tenant_missing");
  let { childSpec, escrow, until } = buildEscrow(payerRow, params, tenant.tier);
  return issueChildGrant(payerRow, childSpec, issuedBy, { escrow, heldUntil: until });
}

// A grant is an escrow iff it carries scope.escrow. Stage-1 state is derived from the grant's
// own status: active custodian = "open"; released (expired/revoked) = "refunded". "captured"
// arrives in stage 2 with the capture path.
export function escrowBlock(grantRow) {
  let block = parseJson(grantRow.scope)?.escrow;
  return block && typeof block === "object" ? block : null;
}
export function escrowState(grantRow) {
  if (grantRow.status === "captured") return "captured"; // terminal: value released to the payee
  if (grantRow.status === "expired" || grantRow.status === "revoked") return "refunded";
  return "open";
}
export function serializeEscrow(grantRow) {
  let b = escrowBlock(grantRow),
    budget = parseJson(grantRow.budget);
  return {
    id: b?.escrow_id ?? grantRow.id,
    grant_id: grantRow.id,
    state: escrowState(grantRow),
    denom: b?.denom ?? "mesh",
    amount: Number(budget?.usd_cents ?? 0),
    payer_grant: b?.payer_grant ?? grantRow.parent,
    payee_tenant: b?.payee_tenant ?? null,
    payee_ref: b?.payee_ref ?? null,
    condition: b?.condition ?? null,
    opened_at: b?.opened_at ?? Number(grantRow.iat),
    deadline: Number(grantRow.exp),
  };
}

// What a capture pays the payee: the value this hold still holds ITSELF. For every hold opened
// since a hold stopped being able to pay for another one (buildEscrow), that is all of it. It is
// less only when value was passed on under the hold: what was captured directly under it is in
// `settled`, and whatever is held on it is either still pledged to a hold underneath or was
// spent further down (a grant keeps what the keys under it used held, see unusedOf in grants.js).
// Neither is this hold's to pay. (captureEscrow also waits while anything under the hold is still
// open.) On rows that only this code has touched, captures therefore never credit more than the
// payer paid, whatever is under a hold. NOT covered: a hold left OPEN under a hold that older code
// had already ended. That code paid out, or gave back, the upper hold's whole amount, the lower
// hold's part included, so capturing the lower hold credits that part a second time. A rule for
// it was tried and taken out again (it only looked one level up, and it turned away a delivery
// that should be paid when the hold above had merely been cancelled). The live runtime had no
// such row when this went live, and none can be made now: a hold cannot open a hold.
export function captureAmount(grantRow) {
  let budget = normalizeUsage(parseJson(grantRow.budget)).usd_cents,
    held = normalizeUsage(parseJson(grantRow.reserved)).usd_cents,
    paid = normalizeUsage(parseJson(grantRow.settled)).usd_cents;
  return Math.max(0, budget - paid - held);
}

// Resolve either the custodian grant id (gr_...) OR the stable escrow id (es_...) to the escrow
// grant row. Only try the grants PK lookup for a gr_ id — a receipt carries the es_ id, which can
// never be a grant PK, so an unconditional getGrant was a wasted round-trip on every receipt. The
// es_ path is indexed (grants_escrow_id on scope->'escrow'->>'escrow_id'), not a full scan.
async function findEscrowGrant(idOrEscrowId) {
  let id = String(idOrEscrowId);
  if (id.startsWith("gr")) {
    let byGrant = await getGrant(id);
    if (byGrant && escrowBlock(byGrant)) return byGrant;
  }
  let r = await sql`SELECT * FROM grants WHERE scope->'escrow'->>'escrow_id' = ${id} LIMIT 1`;
  return r[0] || null;
}

// CAPTURE — the one new primitive (stage 2). Resolve the held value to the payee on a verified
// condition. The CALLER must have verified the condition; captureEscrow enforces the state machine
// and the value movement, EXACTLY ONCE. The active->captured flip (RETURNING guard, under
// FOR UPDATE) is the idempotency + mutual-exclusion lever: a replay, a second receipt, or a race
// with the reaper/revoke credits the payee once and never double-settles the payer. Once captured,
// the reaper and revoke (both status='active') can never touch it; a refunded/expired escrow
// (status!='active') can never be captured. Locks child then parent, the order the reaper takes, so
// it cannot deadlock against the reaper. It CAN against revokeGrantTree (corrected 2026-10-09; this
// note used to say it could not): a cancel of the payer's key holds the payer's grant while it asks
// for the holds under it, and a capture holds one of those and asks for the payer's grant. Postgres
// then aborts one of the two. The cancel tries again (grants.js). A capture that is aborted throws
// with nothing changed; the receipt webhook then answers an error before it has recorded the
// receipt, so the same receipt sent again is tried again.
// NOT CHECKED HERE (noted 2026-10-09): whether a grant ABOVE the hold has ended. The hold's own key
// is refused once one has (grants.js, endedAbove), but a signed receipt still captures the hold: its
// value is still held on the payer, and a rule that turned such a capture away was tried here and
// taken out again the same day (see the note beside captureAmount). A hold can only be in that
// state if a cancel of the grant above missed it: older code did, when the hold was opened at that
// very moment; the cancel now looks again for such a hold (revokeGrantTree in grants.js).
export async function captureEscrow(idOrEscrowId, { source = "capture", ref = null } = {}) {
  let g0 = await findEscrowGrant(idOrEscrowId);
  if (!g0) throw new HttpError(404, "escrow_not_found");
  if (!escrowBlock(g0)) throw new HttpError(404, "not_escrow");
  let b = escrowBlock(g0),
    out = { captured: false, escrow_id: b.escrow_id, reason: null };
  await sql.begin(async (tx) => {
    let g = (await tx`SELECT * FROM grants WHERE id = ${g0.id} FOR UPDATE`)[0];
    if (!g || g.status !== "active") return void (out.reason = "not_active:" + (g?.status || "gone"));
    // A hold waits while anything under it is still open, exactly as a grant waits before it
    // lets go (releaseExpiredGrant): until then the value pledged below may yet come back, and a
    // hold that had already ended as captured could never pay it or give it back. This only
    // LOOKS at the grants below; it locks none of them (child, then parent, is the only order).
    let below = await tx`SELECT 1 FROM grants WHERE parent = ${g.id} AND status = 'active' LIMIT 1`;
    if (below.length) return void (out.reason = "pledged_to_a_hold_below");
    // Worked out from the row as it is now, under the lock, and BEFORE the flip: a hold with
    // nothing of its own left to pay stays open (it is refunded at its deadline, which gives
    // back nothing it does not have) instead of ending as a capture of nothing.
    let amount = captureAmount(g),
      d = { usd_cents: amount, calls: 0, deploys: 0 };
    if (amount <= 0) return void (out.reason = "nothing_left_to_capture");
    let flipped = await tx`UPDATE grants SET status = 'captured' WHERE id = ${g.id} AND status = 'active' RETURNING id`;
    if (flipped.length !== 1) return void (out.reason = "already_resolved"); // someone else resolved it
    // The payer PAID: convert the held reservation into a settlement on the parent — reserved down
    // (no longer held), settled up (spent). remaining is unchanged (the payer lost access at open);
    // this is the OPPOSITE of refund, which returns reserved to the payer. Only `amount` moves:
    // anything paid out under this hold stays held on the parent, which is how spend below a
    // grant is counted (unusedOf in grants.js).
    if (g.parent) {
      let p = (await tx`SELECT reserved, settled FROM grants WHERE id = ${g.parent} FOR UPDATE`)[0];
      if (p) {
        let rem = subtractUsage(normalizeUsage(parseJson(p.reserved)), d),
          set = addUsage(normalizeUsage(parseJson(p.settled)), d);
        await tx`UPDATE grants SET reserved = ${{ usd_cents: Math.max(0, rem.usd_cents), calls: Math.max(0, rem.calls), deploys: Math.max(0, rem.deploys) }}::jsonb, settled = ${set}::jsonb WHERE id = ${g.parent}`;
      }
    }
    // Two ledger rows are the durable record of truth (not the generic outbox, whose env-guard would
    // drop a cross-tenant credit and whose deliverer would reject the kind): the payer's spend, and
    // the payee's owed MESH credit keyed by escrow id. MeshMarket reconciles the payee balance from
    // the mesh-credit rows (actual balance delivery is the meshmarket side, a follow-up).
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${g.tenant}, ${g.id}, ${g.parent}, 'escrow-capture', ${amount}, 0, 0, ${b.escrow_id}, ${"captured for " + b.payee_tenant})`;
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${b.payee_tenant}, ${g.id}, ${g.parent}, 'mesh-credit', ${amount}, 0, 0, ${b.escrow_id}, ${"escrow delivered via " + source + (ref ? " receipt=" + ref : "")}) `;
    ((out.captured = true), (out.amount = amount), (out.payee_tenant = b.payee_tenant), (out.receipt = ref));
  });
  if (out.captured)
    // provenance: the triggering receipt id is recorded on the event so an auditor can trace a
    // mesh-credit row back to the exact delivery receipt that authorized the value movement.
    await recordEvent("escrow.captured", { escrow_id: out.escrow_id, amount: out.amount, payee_tenant: out.payee_tenant, source, receipt: ref }, g0.tenant, source);
  return out;
}

// receipt:mesh condition — a signed MeshMarket delivery receipt (its HMAC already verified by the
// webhook) is the external, non-repudiable delivery proof. Verify the escrow's condition kind and
// (if set) its ref, then capture. Never throws for a receipt that names no/unknown/mismatched
// escrow — it just declines, so a stray receipt can never error the webhook.
export async function captureFromMeshReceipt(receipt) {
  let id = String(receipt?.escrow_id || "");
  if (!id) return { captured: false, reason: "no_escrow_id" };
  let g = await findEscrowGrant(id);
  if (!g) return { captured: false, reason: "escrow_not_found" };
  let b = escrowBlock(g);
  if (b?.condition?.kind !== "receipt:mesh") return { captured: false, reason: "condition_mismatch" };
  if (b.condition.ref && String(receipt.capability ?? receipt.ref ?? "") !== b.condition.ref)
    return { captured: false, reason: "ref_mismatch" };
  // Defense: if the signed receipt names a payee, it MUST be this escrow's payee. The receipt is
  // HMAC-signed by a trusted secret, but a mis-routed receipt (right escrow_id, wrong payee) must
  // never settle to the escrow's fixed payee on the strength of the id alone (review 2026-09-27).
  let receiptPayee = receipt.payee_tenant ?? receipt.payee ?? null;
  if (receiptPayee != null && String(receiptPayee) !== b.payee_tenant)
    return { captured: false, reason: "payee_mismatch" };
  return captureEscrow(g.id, { source: "receipt:mesh", ref: String(receipt.receipt_id ?? "") });
}
