// MeshMarket rail: an agent buys one MeshMarket capability out of its own grant budget.
//
// The runtime is the buyer. It holds ONE MeshMarket account, enrolled once by the owner
// (POST /api/admin/meshmarket/enroll), whose key is sealed in the vault and never leaves
// this process. Every purchase is a payment job (payment_jobs, requirement.rail =
// "meshmarket") on the same reserve -> settle / release pattern as the x402 jobs:
//
//   start     — check the grant (cap present, not an escrow custodian), RESERVE maxPrice
//               on it, write the job as `calling`, THEN call MeshMarket with
//               idempotency-key = job id and x-max-price = maxPrice. MeshMarket replays the
//               original outcome for a repeated key and refuses a price above the ceiling,
//               so a retry never charges twice and never charges more than was reserved.
//   held      — a pay-on-proof listing holds the payment on MeshMarket; the job waits.
//   reconcile — `calling`: send the SAME call again (same key) and apply what comes back.
//               `held`: read the hold (GET /api/holds/:id, the buyer's own view) and settle
//               what MeshMarket actually kept: released = price (plus a stake a release
//               verdict forfeits), split = floor(price x share / 100) (MeshMarket's own
//               splitAmounts gross), refunded = 0. The rest of the reservation goes back.
//   sweep     — every minute (index.js) each open market job is reconciled; nothing moves
//               while the kill switch is on.
//
// MeshMarket's ledger is where the money moves. This side records the agent's BUDGET:
// `reserve`, then `meshmarket-settle` for what was spent and `release` for what was not.
// There is no payee row on this side, so nothing here can ever pay a provider twice.
// An answer this side cannot read never moves budget: the job stays open, and after
// MAX_ATTEMPTS it stops in `review` (reservation kept, event raised) for a person.
import { HttpError, newId, parseJson, sha256Hex } from "./util.js";
import { env } from "./config.js";
import { getSetting, isKillSwitchOn, recordEvent, setSetting, sql } from "./db.js";
import { vaultDecrypt, vaultEncrypt } from "./tokens.js";
import { convertReservation, loadJobForUpdate, releaseReservation, reserveOnGrant, serializeJob } from "./payments.js";

export const MARKET_JOB_CAP = "payments.meshmarket";
export const MARKET_ACTION = "payment.meshmarket";
export const MARKET_MAX_ATTEMPTS = 30; // one sweep a minute: half an hour of no answer, then a person looks
const KEY_SETTING = "meshmarket_key";
const HANDLE_SETTING = "meshmarket_handle";
const INPUT_MAX = 16000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{2,39}$/;

export function marketConfig(envObj = env) {
  return { url: String(envObj.MESHMARKET_URL || "https://market.meshtool.ai").replace(/\/$/, "") };
}

async function marketKey() {
  const raw = await getSetting(KEY_SETTING);
  if (!raw) return null;
  try {
    return vaultDecrypt(JSON.parse(raw));
  } catch {
    throw new HttpError(503, "meshmarket_key_unreadable");
  }
}

// One HTTP exchange with MeshMarket. Never throws: an unreachable market is status 0.
async function marketFetch(path, { method = "GET", body, headers = {}, key } = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const r = await fetchImpl(marketConfig().url + path, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", ...(key ? { "x-agent-key": key } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await r.json();
    } catch {}
    return { status: r.status, body: json && typeof json === "object" ? json : {}, json: !!json };
  } catch {
    return { status: 0, body: { error: "unreachable" }, json: false };
  }
}

// ---- the buyer account (owner only) ----------------------------------------------
export async function enrollMarketAccount({ handle }, deps = {}) {
  if (await getSetting(KEY_SETTING)) throw new HttpError(409, "meshmarket_already_enrolled", { handle: await getSetting(HANDLE_SETTING) });
  const h = String(handle || "").trim().toLowerCase();
  if (!HANDLE.test(h)) throw new HttpError(400, "handle_invalid", { hint: "3-40 characters: a-z, 0-9 and -" });
  // Fail closed BEFORE an account exists whose key this side could not keep.
  try {
    vaultEncrypt("probe");
  } catch {
    throw new HttpError(503, "unarmed", { needs: "VAULT_KEY" });
  }
  const r = await marketFetch("/api/accounts", { method: "POST", body: { handle: h } }, deps);
  if (r.status !== 201 || typeof r.body.api_key !== "string") throw new HttpError(502, "meshmarket_signup_failed", { status: r.status, error: r.body.error ?? null });
  const name = String(r.body.handle || h);
  await setSetting(KEY_SETTING, JSON.stringify(vaultEncrypt(r.body.api_key)));
  await setSetting(HANDLE_SETTING, name);
  await recordEvent("meshmarket.enrolled", { handle: name }, null, "admin");
  return { enrolled: true, handle: name, credits: r.body.credits ?? null };
}

export async function marketStatus(deps = {}) {
  const url = marketConfig().url;
  const key = await marketKey();
  const rows = await sql`SELECT status, count(*)::int AS n FROM payment_jobs WHERE requirement->>'rail' = 'meshmarket' GROUP BY status`;
  const jobs = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  if (!key) return { enrolled: false, url, jobs };
  const r = await marketFetch("/api/account", { key }, deps);
  return { enrolled: true, handle: await getSetting(HANDLE_SETTING), url, reachable: r.status === 200, credits: r.status === 200 ? (r.body.credits ?? null) : null, jobs };
}

// ---- jobs -----------------------------------------------------------------------------
// The request, checked and shaped once: the same check runs before an approval is filed
// (so nobody is asked about a request that would be refused) and again when it runs.
export function marketIntent(b) {
  const slug = String(b?.slug || "");
  if (!SLUG.test(slug)) throw new HttpError(400, "bad_slug");
  const maxPrice = Number(b?.maxPrice);
  if (!Number.isInteger(maxPrice) || maxPrice < 1 || maxPrice > 100000) throw new HttpError(400, "bad_max_price", { min: 1, max: 100000 });
  const inputJson = JSON.stringify(b?.input ?? {});
  if (inputJson.length > INPUT_MAX) throw new HttpError(413, "input_too_large", { max: INPUT_MAX });
  return { slug, maxPrice, input: JSON.parse(inputJson) };
}

export async function getMarketJob(id, tenantId) {
  const rows = await sql`SELECT * FROM payment_jobs WHERE id = ${String(id)} AND tenant = ${tenantId} AND requirement->>'rail' = 'meshmarket'`;
  return serializeJob(rows[0]);
}

export async function startMarketJob({ grant, ...request }, deps = {}) {
  const caps = parseJson(grant.caps);
  if (!Array.isArray(caps) || !caps.includes(MARKET_JOB_CAP)) throw new HttpError(403, "cap_missing", { cap: MARKET_JOB_CAP });
  // An escrow custodian's budget IS someone's held payment: it can never be spent here.
  const scope = parseJson(grant.scope);
  if (scope && typeof scope === "object" && scope.escrow !== undefined) throw new HttpError(403, "escrow_custodian_cannot_pay");
  const { slug, maxPrice, input } = marketIntent(request);
  const key = await marketKey();
  if (!key) throw new HttpError(503, "meshmarket_unenrolled");
  const id = newId("pay");
  const requirement = { rail: "meshmarket", slug, max_price: maxPrice, input };
  const hash = sha256Hex(JSON.stringify({ rail: "meshmarket", slug, max_price: maxPrice, input }));
  const job = await sql.begin(async (tx) => {
    const g = await reserveOnGrant(tx, grant.id, maxPrice);
    await tx`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${g.tenant}, ${g.id}, ${g.parent}, 'reserve', ${maxPrice}, 0, 0, ${id}, 'reserved for MeshMarket job')`;
    const [row] = await tx`INSERT INTO payment_jobs (id, tenant, grant_id, status, order_id, amount_usd_cents, intent_hash, requirement, receipt)
      VALUES (${id}, ${g.tenant}, ${g.id}, 'calling', ${slug}, ${maxPrice}, ${hash}, ${requirement}::jsonb, ${{ attempts: 0 }}::jsonb)
      RETURNING *`;
    return serializeJob(row);
  });
  await recordEvent("payment.meshmarket.started", { id, slug, max_price: maxPrice }, job.tenant, grant.sub);
  return dispatch(job, key, deps);
}

// Send (or re-send) the job's one call. Same idempotency key every time.
async function dispatch(job, key, deps) {
  const req = job.requirement;
  const r = await marketFetch(
    `/api/call/${encodeURIComponent(req.slug)}`,
    { method: "POST", key, body: { input: req.input }, headers: { "idempotency-key": job.id, "x-max-price": String(req.max_price) } },
    deps,
  );
  const b = r.body;
  if (r.status === 200 && b.ok !== false) {
    const charged = Number(b.charged);
    const callId = typeof b.call_id === "string" ? b.call_id : "";
    if (Number.isInteger(charged) && charged >= 0 && callId) {
      if (b.held === true && typeof b.hold_id === "string")
        return moveJob(job, "calling", "held", { call_id: callId, hold_id: b.hold_id, charged, release_at: b.release_at ?? null });
      return finishJob(job, ["calling"], charged, { call_id: callId, charged, outcome: "settled" });
    }
  }
  // A MeshMarket answer that says what happened to the money is final.
  if (r.json && b.error && r.status !== 200 && !(r.status === 409 && b.error === "call_in_flight") && r.status !== 429) {
    if (b.refunded === false) return reviewJob(job, "meshmarket_refund_failed", { call_id: b.call_id ?? null, status: r.status });
    if (r.status < 500 || b.refunded === true) return finishJob(job, ["calling"], 0, { outcome: "failed", status: r.status, error: String(b.error).slice(0, 80), call_id: b.call_id ?? null });
  }
  // Anything else (unreachable, 429, in flight, a 5xx with no money answer, a 200 this side
  // cannot read): unknown. Nothing moves; the same call goes again on the next pass.
  return countAttempt(job, `no_answer:${r.status}`);
}

async function moveJob(job, from, to, receipt) {
  const out = await sql.begin(async (tx) => {
    const row = await loadJobForUpdate(tx, job.id, job.tenant);
    if (!row) throw new HttpError(404, "payment_job_not_found");
    if (row.status !== from) return serializeJob(row);
    const [u] = await tx`UPDATE payment_jobs SET status = ${to}, tx = ${receipt.call_id}, receipt = ${{ ...(parseJson(row.receipt) || {}), ...receipt }}::jsonb, error = NULL, updated_at = now()
      WHERE id = ${row.id} RETURNING *`;
    return serializeJob(u);
  });
  if (out.status === to && job.status !== to) await recordEvent(`payment.meshmarket.${to}`, { id: out.id, slug: out.order_id, call_id: receipt.call_id, hold_id: receipt.hold_id ?? null }, out.tenant, null);
  return out;
}

// The end of a job: `spent` of the reservation becomes settled, the rest goes back. Under
// FOR UPDATE and only from an open state, so a sweep racing a reconcile settles once.
async function finishJob(job, from, spent, receipt) {
  const out = await sql.begin(async (tx) => {
    const row = await loadJobForUpdate(tx, job.id, job.tenant);
    if (!row) throw new HttpError(404, "payment_job_not_found");
    if (!from.includes(row.status)) return { job: serializeJob(row), moved: false };
    const s = Math.max(0, Math.floor(spent) || 0);
    const ref = receipt.call_id || row.id;
    if (s > 0) await convertReservation(tx, row.grant_id, s, ref, "meshmarket-settle", "MeshMarket call settled");
    const back = row.amount_usd_cents - s;
    if (back > 0) await releaseReservation(tx, row.grant_id, back, row.id, "MeshMarket job: unspent reservation returned");
    const status = s > 0 ? "settled" : receipt.outcome === "failed" ? "failed" : "refunded";
    const [u] = await tx`UPDATE payment_jobs SET status = ${status}, tx = ${receipt.call_id ?? row.tx}, receipt = ${{ ...(parseJson(row.receipt) || {}), ...receipt, spent: s }}::jsonb,
      error = ${status === "failed" ? receipt.error || "failed" : null}, updated_at = now() WHERE id = ${row.id} RETURNING *`;
    return { job: serializeJob(u), moved: true };
  });
  if (out.moved) await recordEvent(`payment.meshmarket.${out.job.status}`, { id: out.job.id, slug: out.job.order_id, spent: out.job.receipt?.spent ?? 0, call_id: out.job.tx }, out.job.tenant, null);
  return out.job;
}

async function countAttempt(job, reason) {
  const out = await sql.begin(async (tx) => {
    const row = await loadJobForUpdate(tx, job.id, job.tenant);
    if (!row || row.status !== job.status) return { job: serializeJob(row), review: false };
    const receipt = parseJson(row.receipt) || {};
    const attempts = (Number(receipt.attempts) || 0) + 1;
    const review = attempts >= MARKET_MAX_ATTEMPTS;
    const [u] = await tx`UPDATE payment_jobs SET status = ${review ? "review" : row.status}, receipt = ${{ ...receipt, attempts }}::jsonb,
      error = ${review ? "no_answer_after_" + attempts + "_attempts" : reason}, updated_at = now() WHERE id = ${row.id} RETURNING *`;
    return { job: serializeJob(u), review };
  });
  if (out.review) await recordEvent("payment.meshmarket.review", { id: out.job.id, slug: out.job.order_id, reason: out.job.error }, out.job.tenant, null);
  return out.job;
}

// Stop for a person: the reservation is KEPT (the money may be gone on MeshMarket's side).
async function reviewJob(job, reason, extra) {
  const out = await sql.begin(async (tx) => {
    const row = await loadJobForUpdate(tx, job.id, job.tenant);
    if (!row || (row.status !== "calling" && row.status !== "held")) return serializeJob(row);
    const [u] = await tx`UPDATE payment_jobs SET status = 'review', receipt = ${{ ...(parseJson(row.receipt) || {}), ...extra }}::jsonb, error = ${reason}, updated_at = now()
      WHERE id = ${row.id} RETURNING *`;
    return serializeJob(u);
  });
  await recordEvent("payment.meshmarket.review", { id: out.id, slug: out.order_id, reason }, out.tenant, null);
  return out;
}

// What the buyer actually lost on a resolved hold (MeshMarket's own arithmetic).
export function holdSpend(h) {
  const price = Number(h?.price);
  if (!Number.isInteger(price) || price < 0) return null;
  const stake = Number(h?.stake) || 0;
  if (h.state === "released") return price + (h.verdict === "release" ? stake : 0);
  if (h.state === "split") {
    const share = Math.max(0, Math.min(100, parseInt(h.provider_share, 10) || 0));
    return Math.floor((price * share) / 100);
  }
  if (h.state === "refunded") return 0;
  return null; // held or disputed: not over yet
}

async function reconcileJob(job, deps) {
  if (job.status !== "calling" && job.status !== "held") return job;
  const key = await marketKey();
  if (!key) return job;
  if (job.status === "calling") return dispatch(job, key, deps);
  const rc = job.receipt || {};
  const r = await marketFetch(`/api/holds/${encodeURIComponent(rc.hold_id)}`, { key }, deps);
  if (r.status !== 200) return countAttempt(job, `hold_read:${r.status}`);
  const spent = holdSpend(r.body);
  if (spent === null) {
    // Still open on MeshMarket. Mark it looked-at so the sweep (oldest first) moves on to the
    // next job instead of re-reading the same open holds every pass.
    const [u] = await sql`UPDATE payment_jobs SET updated_at = now() WHERE id = ${job.id} AND status = 'held' RETURNING *`;
    return u ? serializeJob(u) : job;
  }
  return finishJob(job, ["held"], spent, {
    call_id: rc.call_id,
    outcome: r.body.state,
    verdict: r.body.verdict ?? null,
    provider_share: r.body.provider_share ?? null,
    resolved_at: r.body.resolved_at ?? null,
  });
}

export async function reconcileMarketJob({ jobId, tenantId }, deps = {}) {
  const job = await getMarketJob(jobId, tenantId);
  if (!job) throw new HttpError(404, "payment_job_not_found");
  return reconcileJob(job, deps);
}

// The buyer accepts a held result: MeshMarket pays the provider now, then this side settles.
export async function acceptMarketJob({ jobId, tenantId }, deps = {}) {
  const job = await getMarketJob(jobId, tenantId);
  if (!job) throw new HttpError(404, "payment_job_not_found");
  if (job.status !== "held") throw new HttpError(409, "payment_job_not_held", { status: job.status });
  const key = await marketKey();
  if (!key) throw new HttpError(503, "meshmarket_unenrolled");
  const r = await marketFetch(`/api/holds/${encodeURIComponent(job.receipt.hold_id)}/accept`, { method: "POST", key, body: {} }, deps);
  // 409 = the hold was already resolved (accepted, timed out, disputed): read what it is.
  if (r.status !== 200 && r.status !== 409) throw new HttpError(502, "meshmarket_accept_failed", { status: r.status, error: r.body.error ?? null });
  return reconcileJob(job, deps);
}

// Every open market job, oldest first. Nothing while the kill switch is on.
export async function sweepMarketJobs({ limit = 50 } = {}, deps = {}) {
  if (await isKillSwitchOn()) return { skipped: "kill_switch_on", checked: 0 };
  if (!(await getSetting(KEY_SETTING))) return { skipped: "unenrolled", checked: 0 };
  const rows = await sql`SELECT * FROM payment_jobs WHERE requirement->>'rail' = 'meshmarket' AND status IN ('calling', 'held')
    ORDER BY updated_at ASC LIMIT ${Math.min(200, Math.max(1, limit))}`;
  const out = { checked: 0, errors: 0, now: {} };
  for (const row of rows) {
    out.checked++;
    try {
      const j = await reconcileJob(serializeJob(row), deps);
      out.now[j.status] = (out.now[j.status] || 0) + 1;
    } catch {
      out.errors++;
    }
  }
  return out;
}
