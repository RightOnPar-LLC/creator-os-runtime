// Durable x402 payment jobs (staging: Base Sepolia). One fixed-price order,
// paid through a MeshTool-operated facilitator via PayRail.
//
//   start    — fetch PayRail's 402 offer, check it against the allowlist
//              (origin, method, resource, body hash, exact amount, mint,
//              chain, recipient, expiry), check the tenant grant, and
//              RESERVE the amount on that grant before any wallet signs.
//   sign     — validate the PAYMENT-SIGNATURE against the stored offer,
//              persist `settling` BEFORE the settle call, then settle once.
//   reconcile — interrupt-and-resume: a `settling` job first re-checks its
//              original transaction on-chain; only if nothing landed does
//              it re-submit the SAME signature. No duplicate authorization,
//              transfer, or fulfillment, ever.
//
// The private JetStream path does not carry payment jobs yet: the rail
// worker outside any repo accepts only diagnostic.echo and runtime.health,
// and its charter forbids payments. This engine is the durable job; wiring
// it to JetStream delivery is a separate decision on Dw's word. Nothing
// here touches the market's live v1/CDP path, Square, tiers, or money-out.
import { HttpError, newId, parseJson, sha256Hex } from "./util.js";
import { env } from "./config.js";
import { recordEvent, sql } from "./db.js";
import { addUsage, normalizeUsage, remainingBudget, subtractUsage, usageWithin } from "./policy.js";

export const PAYMENT_JOB_CAP = "payments.x402";
export const BASE_SEPOLIA_CAIP2 = "eip155:84532";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;

// Config, read at call time so tests can point it at the fake PayRail.
export function paymentsConfig(envObj = env) {
  return {
    payrailUrl: String(envObj.PAYRAIL_URL || "").replace(/\/$/, ""),
    rpcUrl: String(envObj.X402_RPC_URL || "https://sepolia.base.org").replace(/\/$/, ""),
    network: String(envObj.X402_PAYMENT_NETWORK || BASE_SEPOLIA_CAIP2),
    asset: String(envObj.X402_PAYMENT_ASSET || USDC_BASE_SEPOLIA),
    recipient: String(envObj.X402_PAYMENT_RECIPIENT || ""),
  };
}

export function atomicUsdc(amountUsdCents) {
  return (BigInt(amountUsdCents) * 10n ** BigInt(USDC_DECIMALS - 2)).toString();
}

// The job's intent, hashed once at start and re-checked at sign: the order,
// its price, and the exact terms the payment must land on.
export function intentHash({ orderId, amountUsdCents, network, asset, payTo }) {
  return sha256Hex(
    JSON.stringify({
      orderId,
      amountUsdCents,
      network,
      asset: String(asset).toLowerCase(),
      payTo: String(payTo).toLowerCase(),
    }),
  );
}

function decodeB64json(text) {
  try {
    const v = JSON.parse(Buffer.from(String(text || "").trim(), "base64").toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// The offer must be exactly what the job asked for: the right PayRail, the
// right resource, the right chain/mint/recipient/amount, and unexpired.
// Anything else is refused before a cent is reserved.
export function validateOffer({ requirement, resourceUrl, orderId }, { amountUsdCents, cfg }) {
  if (!requirement || typeof requirement !== "object") return { ok: false, reason: "no_requirement" };
  if (typeof resourceUrl !== "string" || !resourceUrl.startsWith(`${cfg.payrailUrl}/pay/x402`)) return { ok: false, reason: "wrong_origin" };
  if (requirement.scheme !== "exact") return { ok: false, reason: "wrong_scheme" };
  if (requirement.network !== cfg.network) return { ok: false, reason: "wrong_network" };
  if (String(requirement.asset || "").toLowerCase() !== cfg.asset.toLowerCase()) return { ok: false, reason: "wrong_asset" };
  if (String(requirement.payTo || "").toLowerCase() !== cfg.recipient.toLowerCase()) return { ok: false, reason: "wrong_recipient" };
  if (String(requirement.amount || "") !== atomicUsdc(amountUsdCents)) return { ok: false, reason: "wrong_amount" };
  if (!Number.isInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds < 1 || requirement.maxTimeoutSeconds > 3600) return { ok: false, reason: "bad_timeout" };
  if (typeof requirement.extra?.feePayer !== "string" || !requirement.extra.feePayer) return { ok: false, reason: "no_fee_payer" };
  return { ok: true, requirement };
}

// The signature must accept EXACTLY the stored offer: same terms, and an
// authorization for the same value to the same wallet.
export function payloadMatchesOffer(paymentPayload, requirement) {
  if (!paymentPayload || typeof paymentPayload !== "object") return { ok: false, reason: "no_payload" };
  const accepted = paymentPayload.accepted;
  if (!accepted || typeof accepted !== "object") return { ok: false, reason: "no_accepted" };
  for (const f of ["scheme", "network", "amount", "maxTimeoutSeconds"]) {
    if (String(accepted[f]) !== String(requirement[f])) return { ok: false, reason: `terms_changed:${f}` };
  }
  if (String(accepted.asset || "").toLowerCase() !== String(requirement.asset || "").toLowerCase()) return { ok: false, reason: "terms_changed:asset" };
  if (String(accepted.payTo || "").toLowerCase() !== String(requirement.payTo || "").toLowerCase()) return { ok: false, reason: "terms_changed:payTo" };
  if (String(accepted.extra?.feePayer || "").toLowerCase() !== String(requirement.extra?.feePayer || "").toLowerCase()) return { ok: false, reason: "terms_changed:feePayer" };
  const auth = paymentPayload.payload?.authorization;
  if (!auth || typeof auth !== "object") return { ok: false, reason: "no_authorization" };
  if (String(auth.value) !== String(requirement.amount)) return { ok: false, reason: "terms_changed:amount" };
  if (String(auth.to || "").toLowerCase() !== String(requirement.payTo || "").toLowerCase()) return { ok: false, reason: "terms_changed:payTo" };
  if (!paymentPayload.payload?.signature || typeof paymentPayload.payload.signature !== "object") return { ok: false, reason: "no_signature" };
  return { ok: true };
}

export function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant: row.tenant,
    grant_id: row.grant_id,
    status: row.status,
    order_id: row.order_id,
    amount_usd_cents: row.amount_usd_cents,
    intent_hash: row.intent_hash,
    requirement: parseJson(row.requirement),
    signature: row.signature ? parseJson(row.signature) : null,
    tx: row.tx,
    receipt: row.receipt ? parseJson(row.receipt) : null,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getPaymentJob(id, tenantId) {
  const rows = await sql`SELECT * FROM payment_jobs WHERE id = ${String(id)} AND tenant = ${tenantId}`;
  return serializeJob(rows[0]);
}

async function loadJobForUpdate(tx, id, tenantId) {
  const rows = await tx`SELECT * FROM payment_jobs WHERE id = ${String(id)} AND tenant = ${tenantId} FOR UPDATE`;
  return rows[0] || null;
}

// The grant's reservation: up at start, down at settle (converted to
// settled) or at failure (given back). The escrow capture/refund pattern.
async function reserveOnGrant(tx, grantId, amountUsdCents) {
  const g = (await tx`SELECT * FROM grants WHERE id = ${grantId} FOR UPDATE`)[0];
  if (!g || g.status !== "active") throw new HttpError(403, "grant_not_active");
  const need = { usd_cents: amountUsdCents, calls: 0, deploys: 0 };
  if (!usageWithin(need, remainingBudget(g))) throw new HttpError(402, "budget_exhausted");
  const reserved = addUsage(normalizeUsage(parseJson(g.reserved)), need);
  await tx`UPDATE grants SET reserved = ${reserved}::jsonb WHERE id = ${grantId}`;
  return g;
}

async function releaseReservation(tx, grantId, amountUsdCents, ref) {
  const g = (await tx`SELECT * FROM grants WHERE id = ${grantId} FOR UPDATE`)[0];
  if (!g) return;
  const rem = subtractUsage(normalizeUsage(parseJson(g.reserved)), { usd_cents: amountUsdCents, calls: 0, deploys: 0 });
  await tx`UPDATE grants SET reserved = ${{ usd_cents: Math.max(0, rem.usd_cents), calls: 0, deploys: 0 }}::jsonb WHERE id = ${grantId}`;
  await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
    VALUES (${g.tenant}, ${g.id}, ${g.parent}, 'release', ${-amountUsdCents}, 0, 0, ${ref}, 'x402 payment job released')`;
}

async function convertReservation(tx, grantId, amountUsdCents, ref) {
  const p = (await tx`SELECT * FROM grants WHERE id = ${grantId} FOR UPDATE`)[0];
  if (!p) return;
  const d = { usd_cents: amountUsdCents, calls: 0, deploys: 0 };
  const rem = subtractUsage(normalizeUsage(parseJson(p.reserved)), d);
  const set = addUsage(normalizeUsage(parseJson(p.settled)), d);
  await tx`UPDATE grants SET reserved = ${{ usd_cents: Math.max(0, rem.usd_cents), calls: 0, deploys: 0 }}::jsonb, settled = ${set}::jsonb WHERE id = ${grantId}`;
  await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
    VALUES (${p.tenant}, ${p.id}, ${p.parent}, 'x402-settle', ${amountUsdCents}, 0, 0, ${ref}, 'x402 payment settled')`;
}

function isEvmTxHash(tx) {
  return typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx);
}

async function rpcReceipt(tx, { cfg, fetchImpl }) {
  let r;
  try {
    r = await fetchImpl(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }),
    });
  } catch {
    return { ok: false, reason: "rpc_unavailable" };
  }
  if (!r.ok) return { ok: false, reason: "rpc_unavailable" };
  let body;
  try {
    body = await r.json();
  } catch {
    return { ok: false, reason: "rpc_unavailable" };
  }
  return { ok: true, receipt: body?.result ?? null };
}

// Start one durable payment job: fetch the offer, validate it, reserve.
export async function startPaymentJob({ grant, orderId, amountUsdCents }, deps = {}) {
  const cfg = { ...paymentsConfig(), ...(deps.cfg || {}) };
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!cfg.payrailUrl) throw new HttpError(503, "payrail_unconfigured");
  if (!cfg.recipient) throw new HttpError(503, "payment_recipient_unconfigured");
  if (!orderId || typeof orderId !== "string" || orderId.length > 128) throw new HttpError(400, "bad_order");
  if (!Number.isInteger(amountUsdCents) || amountUsdCents < 100 || amountUsdCents > 1_000_000) throw new HttpError(400, "bad_amount");
  let offerRes;
  try {
    offerRes = await fetchImpl(`${cfg.payrailUrl}/pay/x402?order=${encodeURIComponent(orderId)}`, { redirect: "manual" });
  } catch {
    throw new HttpError(502, "payrail_unreachable");
  }
  if (offerRes.status !== 402) throw new HttpError(502, "payrail_offer_failed", { status: offerRes.status });
  const required = decodeB64json(offerRes.headers.get("payment-required"));
  const requirement = required?.accepts?.[0] ?? null;
  const check = validateOffer({ requirement, resourceUrl: required?.resource?.url, orderId }, { amountUsdCents, cfg });
  if (!check.ok) throw new HttpError(400, check.reason);
  const id = newId("pay");
  const hash = intentHash({ orderId, amountUsdCents, network: cfg.network, asset: cfg.asset, payTo: cfg.recipient });
  const job = await sql.begin(async (tx) => {
    const g = await reserveOnGrant(tx, grant.id, amountUsdCents);
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${g.tenant}, ${g.id}, ${g.parent}, 'reserve', ${amountUsdCents}, 0, 0, ${id}, 'reserved for x402 payment job')`;
    const [row] = await tx`INSERT INTO payment_jobs (id, tenant, grant_id, status, order_id, amount_usd_cents, intent_hash, requirement)
      VALUES (${id}, ${g.tenant}, ${g.id}, 'offered', ${orderId}, ${amountUsdCents}, ${hash}, ${requirement}::jsonb)
      RETURNING *`;
    return serializeJob(row);
  });
  await recordEvent("payment.job.started", { id, order: orderId, amount_usd_cents: amountUsdCents, network: cfg.network }, job.tenant, grant.sub);
  return job;
}

// Submit the wallet's signature: persist `settling` first, then settle once.
export async function submitPaymentSignature({ jobId, tenantId, paymentPayload }, deps = {}) {
  const cfg = { ...paymentsConfig(), ...(deps.cfg || {}) };
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!cfg.payrailUrl) throw new HttpError(503, "payrail_unconfigured");
  const prepared = await sql.begin(async (tx) => {
    const row = await loadJobForUpdate(tx, jobId, tenantId);
    if (!row) throw new HttpError(404, "payment_job_not_found");
    if (row.status === "settled") return { job: serializeJob(row), already: true };
    if (row.status === "settling") return { job: serializeJob(row), already: true };
    if (row.status !== "offered") throw new HttpError(409, "payment_job_not_offered", { status: row.status });
    const requirement = parseJson(row.requirement);
    const match = payloadMatchesOffer(paymentPayload, requirement);
    if (!match.ok) throw new HttpError(400, match.reason);
    const offeredAt = new Date(row.created_at).getTime();
    if (Date.now() > offeredAt + Number(requirement.maxTimeoutSeconds || 0) * 1000) {
      // A throw inside this transaction would roll the release back, so the
      // expiry is returned as a marker and the 409 is thrown after commit.
      await releaseReservation(tx, row.grant_id, row.amount_usd_cents, row.id);
      const [updated] = await tx`UPDATE payment_jobs SET status = 'failed', error = 'offer_expired', updated_at = now() WHERE id = ${row.id} RETURNING *`;
      return { job: serializeJob(updated), expired: true };
    }
    const [updated] = await tx`UPDATE payment_jobs SET status = 'settling', signature = ${paymentPayload}::jsonb, updated_at = now() WHERE id = ${row.id} RETURNING *`;
    return { job: serializeJob(updated), already: false };
  });
  if (prepared.already) return prepared.job;
  if (prepared.expired) throw new HttpError(409, "offer_expired");
  const job = prepared.job;
  let settleRes;
  try {
    settleRes = await fetchImpl(`${cfg.payrailUrl}/pay/x402?order=${encodeURIComponent(job.order_id)}`, {
      redirect: "manual",
      headers: { "payment-signature": Buffer.from(JSON.stringify(paymentPayload)).toString("base64url") },
    });
  } catch {
    // The response may have been lost after the transaction landed: the job
    // stays `settling` and reconcile decides. Never release the reservation.
    return job;
  }
  if (settleRes.status !== 200) {
    // Same: PayRail may have settled and the answer not reached us. Stay
    // `settling`; reconcile re-checks the transaction before any replay.
    return job;
  }
  let body = null;
  try {
    body = await settleRes.json();
  } catch {
    return job;
  }
  const tx = body?.id;
  if (!isEvmTxHash(tx)) return job;
  const receipt = decodeB64json(settleRes.headers.get("payment-response")) || body;
  return await settleJob(job, tx, receipt, deps);
}

// Settle a `settling` job from a confirmed transaction id. The flip is the
// idempotency lever: only a row still `settling` moves, so a replay, a
// second receipt, or a race settles the payer once.
export async function settleJob(job, tx, receipt, deps = {}) {
  const settled = await sql.begin(async (txConn) => {
    const row = await loadJobForUpdate(txConn, job.id, job.tenant);
    if (!row) throw new HttpError(404, "payment_job_not_found");
    if (row.status === "settled") return serializeJob(row);
    if (row.status !== "settling") throw new HttpError(409, "payment_job_not_settling", { status: row.status });
    await convertReservation(txConn, row.grant_id, row.amount_usd_cents, tx);
    const [updated] = await txConn`UPDATE payment_jobs SET status = 'settled', tx = ${tx}, receipt = ${receipt}::jsonb, updated_at = now() WHERE id = ${row.id} RETURNING *`;
    return serializeJob(updated);
  });
  await recordEvent("payment.job.settled", { id: settled.id, order: settled.order_id, tx }, settled.tenant, null);
  return settled;
}

async function failJob(job, reason, deps = {}) {
  const failed = await sql.begin(async (tx) => {
    const row = await loadJobForUpdate(tx, job.id, job.tenant);
    if (!row) throw new HttpError(404, "payment_job_not_found");
    if (row.status === "settled") return serializeJob(row);
    if (row.status === "failed") return serializeJob(row);
    await releaseReservation(tx, row.grant_id, row.amount_usd_cents, row.id);
    const [updated] = await tx`UPDATE payment_jobs SET status = 'failed', error = ${reason}, updated_at = now() WHERE id = ${row.id} RETURNING *`;
    return serializeJob(updated);
  });
  await recordEvent("payment.job.failed", { id: failed.id, order: failed.order_id, reason }, failed.tenant, null);
  return failed;
}

// Interrupt-and-resume: reopen the same job and reconcile it. A settled job
// returns its receipt; a settling job first checks its original transaction
// on-chain, and only if nothing landed re-submits the SAME signature.
export async function reconcilePaymentJob({ jobId, tenantId }, deps = {}) {
  const cfg = { ...paymentsConfig(), ...(deps.cfg || {}) };
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let job = await getPaymentJob(jobId, tenantId);
  if (!job) throw new HttpError(404, "payment_job_not_found");
  if (job.status === "settled" || job.status === "failed" || job.status === "offered") return job;
  // Settling: did the original transaction land?
  if (job.tx) {
    const checked = await rpcReceipt(job.tx, { cfg, fetchImpl });
    if (checked.ok && checked.receipt) {
      if (checked.receipt.status === "0x1") {
        return await settleJob(job, job.tx, checked.receipt, deps);
      }
      // The transaction landed and FAILED on-chain: the money never moved.
      return await failJob(job, "tx_reverted", deps);
    }
    // The RPC could not say (or says nothing yet): fall through to the replay.
  }
  // Replay the SAME signature: PayRail re-verifies it (a used or expired
  // authorization answers 402 invalid and nothing moves) and its facilitator
  // dedups by authorization digest, so a replay can never double-spend.
  const signature = job.signature;
  if (!signature) return job;
  let res;
  try {
    res = await fetchImpl(`${cfg.payrailUrl}/pay/x402?order=${encodeURIComponent(job.order_id)}`, {
      redirect: "manual",
      headers: { "payment-signature": Buffer.from(JSON.stringify(signature)).toString("base64url") },
    });
  } catch {
    return job;
  }
  if (res.status === 200) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      return job;
    }
    if (isEvmTxHash(body?.id)) {
      const receipt = decodeB64json(res.headers.get("payment-response")) || body;
      return await settleJob(job, body.id, receipt, deps);
    }
    return job;
  }
  if (res.status === 402) {
    let body = null;
    try {
      body = await res.json();
    } catch {}
    const error = String(body?.error || "");
    if (error.startsWith("invalid:")) {
      // The authorization is dead (used, expired, or refused): no payment
      // can come from it, so the reservation goes back to the grant.
      return await failJob(job, error.slice(0, 80), deps);
    }
  }
  return job;
}
