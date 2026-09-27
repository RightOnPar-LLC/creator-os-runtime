// Escrow keystone (stage 1: open + read). An escrow is NOT a new value engine — it is a
// child grant held by a neutral custodian. The HOLD is issueChildGrant's reserve (the payer's
// value is parked, unspendable); the REFUND is the reaper / revokeGrantTree release-on-expiry.
// CAPTURE (resolving held value to the payee on a verified condition) is stage 2 and lives
// nowhere yet. See docs/specs/escrow-keystone.md.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { issueChildGrant } from "./grants.js";

// Stage 1 accepts only MESH (closed-loop). A `usd` (real-money, withdrawable) capture would be
// money-out — a hard floor behind the legal envelope — so a usd escrow is refused at the door,
// not merely blocked at capture. Widen this set only when that legal structure exists.
export const ESCROW_DENOMS = ["mesh"];
// The condition kinds a capture (stage 2) will resolve against. Validated at open so an escrow
// can never be created carrying a condition nothing can ever satisfy.
export const ESCROW_CONDITION_KINDS = ["attestation:self-settle", "receipt:mesh"];
export const ESCROW_CUSTODY_CAP = "escrow.hold";

// Validate the open request and shape the custodian child spec + the scope.escrow block.
// Throws HttpError on any bad input; never partially opens.
export function buildEscrow(payerRow, params) {
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
  // Deadline drives the child's ttl; issueChildGrant clamps it to the tier max and the payer's
  // own exp, so an over-long deadline is capped, never widened. Default 1h if none given.
  let now = nowSec();
  let deadline = Math.floor(Number(p.deadline ?? 0));
  let ttlSec = deadline > now ? deadline - now : Math.floor(Number(p.ttlSec ?? 3600));
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
  return { childSpec, escrow };
}

// Open = issue the custodian child. The reserve inside issueChildGrant IS the hold: the payer's
// remaining drops by `amount` and it can no longer spend that value elsewhere. Returns the same
// {row, token} shape as issueChildGrant.
export async function openEscrow(payerRow, params, issuedBy) {
  let { childSpec, escrow } = buildEscrow(payerRow, params);
  return issueChildGrant(payerRow, childSpec, issuedBy, { escrow });
}

// A grant is an escrow iff it carries scope.escrow. Stage-1 state is derived from the grant's
// own status: active custodian = "open"; released (expired/revoked) = "refunded". "captured"
// arrives in stage 2 with the capture path.
export function escrowBlock(grantRow) {
  let block = parseJson(grantRow.scope)?.escrow;
  return block && typeof block === "object" ? block : null;
}
export function escrowState(grantRow) {
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
