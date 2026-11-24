// Routes: durable x402 payment jobs (staging: Base Sepolia).
//
//   POST /api/payments/x402/jobs                 start a job (offer + reserve)
//   GET  /api/payments/x402/jobs/:id             reopen the same job/receipt
//   POST /api/payments/x402/jobs/:id/sign        submit the wallet signature
//   POST /api/payments/x402/jobs/:id/reconcile   interrupt-and-resume
//
// All four need a grant carrying the payments.x402 cap, and a job answers
// only to its own tenant (another tenant gets 404, same as missing).
//
// MeshMarket purchases (src/meshmarket.js), same rules, cap payments.meshmarket:
//   POST /api/payments/meshmarket/jobs                buy one capability (reserve, then call)
//   GET  /api/payments/meshmarket/jobs/:id            reopen the job and its receipt
//   POST /api/payments/meshmarket/jobs/:id/reconcile  interrupt-and-resume / read the hold
//   POST /api/payments/meshmarket/jobs/:id/accept     accept a held result on MeshMarket
// The owner's side: POST /api/admin/meshmarket/enroll (the runtime's buyer account, once),
// GET /api/admin/meshmarket (status), POST /api/admin/meshmarket/sweep (one pass, on demand).
import { app, readJsonBody, requireAdmin, requireGrant } from "../http.js";
import { HttpError, newId, parseJson } from "../util.js";
import { recordEvent, sql } from "../db.js";
import { getPaymentJob, isMarketJob, reconcilePaymentJob, startPaymentJob, submitPaymentSignature } from "../payments.js";
import {
  acceptMarketJob, enrollMarketAccount, getMarketJob, MARKET_ACTION, MARKET_JOB_CAP, marketIntent, marketStatus,
  reconcileMarketJob, startMarketJob, sweepMarketJobs,
} from "../meshmarket.js";
import { recordAutonomyRow } from "../grants.js";
import { autonomyOf, decide } from "../autonomy.js";

app.post("/api/payments/x402/jobs", requireGrant("payments.x402"), async (e) => {
  const auth = e.get("auth");
  const b = await readJsonBody(e);
  const job = await startPaymentJob({ grant: auth.row, orderId: b?.orderId, amountUsdCents: b?.amountUsdCents });
  return e.json({ job }, 201);
});

app.get("/api/payments/x402/jobs/:id", requireGrant("payments.x402"), async (e) => {
  const auth = e.get("auth");
  const job = await getPaymentJob(e.req.param("id"), auth.tenant.id);
  if (!job || isMarketJob(job)) throw new HttpError(404, "payment_job_not_found");
  return e.json({ job });
});

app.post("/api/payments/x402/jobs/:id/sign", requireGrant("payments.x402"), async (e) => {
  const auth = e.get("auth");
  const b = await readJsonBody(e);
  const job = await submitPaymentSignature({ jobId: e.req.param("id"), tenantId: auth.tenant.id, paymentPayload: b?.paymentPayload });
  return e.json({ job });
});

app.post("/api/payments/x402/jobs/:id/reconcile", requireGrant("payments.x402"), async (e) => {
  const auth = e.get("auth");
  const job = await reconcilePaymentJob({ jobId: e.req.param("id"), tenantId: auth.tenant.id });
  return e.json({ job });
});

// A MeshMarket purchase is a value action: the grant's dial decides (refuse / ask / act)
// BEFORE any budget is reserved. "ask" files an approval carrying the checked request; the
// owner runs it with POST /api/approvals/:id, exactly as for an escrow.
app.post("/api/payments/meshmarket/jobs", requireGrant(MARKET_JOB_CAP), async (e) => {
  const auth = e.get("auth");
  const intent = marketIntent(await readJsonBody(e));
  const dial = decide(autonomyOf(parseJson(auth.row.constraints)), MARKET_ACTION);
  if (dial.decision === "refuse") {
    await recordAutonomyRow(auth.row, "autonomy-refused", "meshmarket", `MeshMarket purchase refused at autonomy ${dial.levelName}`, { autonomy: dial.level, decision: "refuse" });
    throw new HttpError(403, dial.reason, { autonomy: dial.levelName });
  }
  if (dial.decision === "ask") {
    const ap = newId("ap");
    await sql`INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, requested_by)
      VALUES (${ap}, ${auth.tenant.id}, ${auth.row.id}, ${MARKET_ACTION}, ${intent}::jsonb, ${dial.level}, ${auth.row.sub})`;
    await recordAutonomyRow(auth.row, "autonomy-ask", ap, "MeshMarket purchase awaits the owner's approval", { autonomy: dial.level, decision: "ask" });
    await recordEvent("autonomy.ask", { action: MARKET_ACTION, approval: ap, level: dial.levelName, slug: intent.slug, max_price: intent.maxPrice }, auth.tenant.id, auth.row.sub);
    return e.json({ status: "awaiting_approval", approval: { id: ap, action: MARKET_ACTION, approve: `POST /api/approvals/${ap}` } }, 202);
  }
  const job = await startMarketJob({ grant: auth.row, ...intent });
  return e.json({ job }, 201);
});

app.get("/api/payments/meshmarket/jobs/:id", requireGrant(MARKET_JOB_CAP), async (e) => {
  const job = await getMarketJob(e.req.param("id"), e.get("auth").tenant.id);
  if (!job) throw new HttpError(404, "payment_job_not_found");
  return e.json({ job });
});

app.post("/api/payments/meshmarket/jobs/:id/reconcile", requireGrant(MARKET_JOB_CAP), async (e) => {
  return e.json({ job: await reconcileMarketJob({ jobId: e.req.param("id"), tenantId: e.get("auth").tenant.id }) });
});

app.post("/api/payments/meshmarket/jobs/:id/accept", requireGrant(MARKET_JOB_CAP), async (e) => {
  return e.json({ job: await acceptMarketJob({ jobId: e.req.param("id"), tenantId: e.get("auth").tenant.id }) });
});

app.post("/api/admin/meshmarket/enroll", requireAdmin, async (e) => {
  return e.json(await enrollMarketAccount({ handle: (await readJsonBody(e))?.handle }), 201);
});

app.get("/api/admin/meshmarket", requireAdmin, async (e) => e.json(await marketStatus()));

app.post("/api/admin/meshmarket/sweep", requireAdmin, async (e) => e.json(await sweepMarketJobs()));
