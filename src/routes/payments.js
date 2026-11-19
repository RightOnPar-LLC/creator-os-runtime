// Routes: durable x402 payment jobs (staging: Base Sepolia).
//
//   POST /api/payments/x402/jobs                 start a job (offer + reserve)
//   GET  /api/payments/x402/jobs/:id             reopen the same job/receipt
//   POST /api/payments/x402/jobs/:id/sign        submit the wallet signature
//   POST /api/payments/x402/jobs/:id/reconcile   interrupt-and-resume
//
// All four need a grant carrying the payments.x402 cap, and a job answers
// only to its own tenant (another tenant gets 404, same as missing).
import { app, readJsonBody, requireGrant } from "../http.js";
import { HttpError } from "../util.js";
import { getPaymentJob, reconcilePaymentJob, startPaymentJob, submitPaymentSignature } from "../payments.js";

app.post("/api/payments/x402/jobs", requireGrant("payments.x402"), async (e) => {
  const auth = e.get("auth");
  const b = await readJsonBody(e);
  const job = await startPaymentJob({ grant: auth.row, orderId: b?.orderId, amountUsdCents: b?.amountUsdCents });
  return e.json({ job }, 201);
});

app.get("/api/payments/x402/jobs/:id", requireGrant("payments.x402"), async (e) => {
  const auth = e.get("auth");
  const job = await getPaymentJob(e.req.param("id"), auth.tenant.id);
  if (!job) throw new HttpError(404, "payment_job_not_found");
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
