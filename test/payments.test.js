// Durable x402 payment jobs (src/payments.js, src/routes/payments.js): start
// offers Base Sepolia terms and reserves the grant; sign settles exactly
// once; reconcile reopens the same receipt and resumes an interrupted job
// without a second submission.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole
// runtime when it is imported, and runtime.test.js already holds that boot.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { req, newTenant, shutdown, dbQuery, payrail, PAYRAIL_NETWORK, PAYRAIL_ASSET, PAYRAIL_RECIPIENT, PAYRAIL_FEE_PAYER, PAYRAIL_TX } from "./harness.js";

afterAll(shutdown);

describe("payments.x402: durable payment jobs on Base Sepolia (staging)", () => {
  let tenant;

  const makeKey = async (budgetUsdCents = 1000) => {
    const r = await req("POST", "/api/grants", {
      token: tenant.token,
      body: { sub: "agent:payer", caps: ["payments.x402", "grant.read"], ttlSec: 600, budget: { usd_cents: budgetUsdCents, calls: 5, deploys: 0 }, constraints: {} },
    });
    expect(r.status).toBe(201);
    return r.json.token;
  };
  const remaining = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining.usd_cents;
  const start = (token, orderId, amountUsdCents) => req("POST", "/api/payments/x402/jobs", { token, body: { orderId, amountUsdCents } });
  const sign = (token, id, paymentPayload) => req("POST", `/api/payments/x402/jobs/${id}/sign`, { token, body: { paymentPayload } });
  const reconcile = (token, id) => req("POST", `/api/payments/x402/jobs/${id}/reconcile`, { token });
  const get = (token, id) => req("GET", `/api/payments/x402/jobs/${id}`, { token });

  const payloadFor = (job, overrides = {}) => {
    const requirement = job.requirement;
    const now = Math.floor(Date.now() / 1000);
    return {
      x402Version: 2,
      accepted: { ...requirement, ...(overrides.accepted || {}) },
      payload: {
        signature: { v: 27, r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) },
        authorization: {
          from: "0x3333333333333333333333333333333333333333",
          to: requirement.payTo,
          value: requirement.amount,
          validAfter: "0",
          validBefore: String(now + 3600),
          nonce: "0x" + "44".repeat(32),
          ...(overrides.authorization || {}),
        },
      },
    };
  };
  const resetFake = () => {
    payrail.mode = "ok";
    payrail.offer = null;
    payrail.seen = [];
    payrail.settledTx = null;
    payrail.txReceipt = null;
  };

  beforeAll(async () => {
    tenant = await newTenant("market-payer", "studio");
  });

  test("start offers Base Sepolia terms and reserves the amount on the grant", async () => {
    resetFake();
    const key = await makeKey();
    const before = await remaining(key);
    payrail.offer = { orderId: "order-t1", amountUsdCents: 100 };
    const r = await start(key, "order-t1", 100);
    expect(r.status).toBe(201);
    const job = r.json.job;
    expect(job.status).toBe("offered");
    expect(job.requirement.network).toBe(PAYRAIL_NETWORK);
    expect(job.requirement.asset).toBe(PAYRAIL_ASSET);
    expect(job.requirement.amount).toBe("1000000");
    expect(job.requirement.payTo).toBe(PAYRAIL_RECIPIENT);
    expect(job.requirement.extra.feePayer).toBe(PAYRAIL_FEE_PAYER);
    expect(await remaining(key)).toBe(before - 100);
  });

  test("start refuses an offer that does not match the terms, and reserves nothing", async () => {
    resetFake();
    const key = await makeKey();
    const before = await remaining(key);
    payrail.offer = { orderId: "order-t2", amountUsdCents: 200 };
    const r = await start(key, "order-t2", 100);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("wrong_amount");
    expect(await remaining(key)).toBe(before);
  });

  test("start refuses when the grant cannot cover the amount", async () => {
    resetFake();
    const key = await makeKey(1000);
    payrail.offer = { orderId: "order-t3", amountUsdCents: 99999 };
    const r = await start(key, "order-t3", 99999);
    expect(r.status).toBe(402);
    expect(r.json.error).toBe("budget_exhausted");
  });

  test("sign with tampered terms is refused and the job stays offered", async () => {
    resetFake();
    const key = await makeKey();
    payrail.offer = { orderId: "order-t4", amountUsdCents: 100 };
    const started = await start(key, "order-t4", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    const r = await sign(key, job.id, payloadFor(job, { accepted: { amount: "999999" } }));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("terms_changed:amount");
    const again = await get(key, job.id);
    expect(again.json.job.status).toBe("offered");
  });

  test("sign settles once; the receipt reopens; a replay submits nothing", async () => {
    resetFake();
    const key = await makeKey();
    const before = await remaining(key);
    payrail.offer = { orderId: "order-t5", amountUsdCents: 100 };
    const started = await start(key, "order-t5", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    const r = await sign(key, job.id, payloadFor(job));
    expect(r.status).toBe(200);
    expect(r.json.job.status).toBe("settled");
    expect(r.json.job.tx).toBe(PAYRAIL_TX);
    expect(r.json.job.receipt).toBeTruthy();
    expect(payrail.seen.length).toBe(1);
    const replay = await sign(key, job.id, payloadFor(job));
    expect(replay.status).toBe(200);
    expect(replay.json.job.tx).toBe(PAYRAIL_TX);
    expect(payrail.seen.length).toBe(1);
    const reopened = await get(key, job.id);
    expect(reopened.json.job.status).toBe("settled");
    expect(reopened.json.job.tx).toBe(PAYRAIL_TX);
    // Settled, not double-counted: reserved back, settled once.
    expect(await remaining(key)).toBe(before - 100);
  });

  test("an expired offer is refused and the reservation is released", async () => {
    resetFake();
    const key = await makeKey();
    const before = await remaining(key);
    payrail.offer = { orderId: "order-t6", amountUsdCents: 100 };
    const started = await start(key, "order-t6", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    await dbQuery("UPDATE payment_jobs SET created_at = now() - interval '2 hours' WHERE id = $1", [job.id]);
    const r = await sign(key, job.id, payloadFor(job));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("offer_expired");
    expect(await remaining(key)).toBe(before);
    const again = await get(key, job.id);
    expect(again.json.job.status).toBe("failed");
  });

  test("interrupt and resume, response dropped after the tx landed: the same signature re-submits once and the facilitator returns the ORIGINAL tx, no second transfer", async () => {
    resetFake();
    const key = await makeKey();
    const before = await remaining(key);
    payrail.offer = { orderId: "order-t7", amountUsdCents: 100 };
    const started = await start(key, "order-t7", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    payrail.mode = "drop";
    const dropped = await sign(key, job.id, payloadFor(job));
    expect(dropped.status).toBe(200);
    expect(dropped.json.job.status).toBe("settling");
    expect(payrail.seen.length).toBe(1);
    // The tx landed on the facilitator but the response was lost, so the
    // runtime does not know its hash. Reconcile re-submits the SAME signature;
    // the facilitator's idempotency returns the original tx, not a new one.
    payrail.mode = "ok";
    payrail.txReceipt = { status: "0x1", blockNumber: "0x123", transactionHash: PAYRAIL_TX };
    const r = await reconcile(key, job.id);
    expect(r.status).toBe(200);
    expect(r.json.job.status).toBe("settled");
    expect(r.json.job.tx).toBe(PAYRAIL_TX);
    expect(payrail.seen.length).toBe(2);
    expect(payrail.seen[1].signature).toEqual(payrail.seen[0].signature);
    // Exactly one conversion: the reservation became one settlement, never two.
    expect(await remaining(key)).toBe(before - 100);
  });

  test("interrupt and resume, tx already known: settles from the chain with no second submission", async () => {
    resetFake();
    const key = await makeKey();
    payrail.offer = { orderId: "order-t7b", amountUsdCents: 100 };
    const started = await start(key, "order-t7b", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    payrail.mode = "drop";
    const dropped = await sign(key, job.id, payloadFor(job));
    expect(dropped.json.job.status).toBe("settling");
    expect(payrail.seen.length).toBe(1);
    // Crash window: the settle response was recorded (tx known) but the
    // status update was interrupted. Reconcile checks the chain first.
    await dbQuery("UPDATE payment_jobs SET tx = $1 WHERE id = $2", [PAYRAIL_TX, job.id]);
    payrail.mode = "ok";
    payrail.txReceipt = { status: "0x1", blockNumber: "0x123", transactionHash: PAYRAIL_TX };
    const r = await reconcile(key, job.id);
    expect(r.status).toBe(200);
    expect(r.json.job.status).toBe("settled");
    expect(r.json.job.tx).toBe(PAYRAIL_TX);
    expect(payrail.seen.length).toBe(1);
  });

  test("interrupt and resume, no tx yet: re-submits the SAME signature once", async () => {
    resetFake();
    const key = await makeKey();
    payrail.offer = { orderId: "order-t8", amountUsdCents: 100 };
    const started = await start(key, "order-t8", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    const payload = payloadFor(job);
    payrail.mode = "drop";
    const dropped = await sign(key, job.id, payload);
    expect(dropped.json.job.status).toBe("settling");
    expect(payrail.seen.length).toBe(1);
    payrail.mode = "ok";
    payrail.txReceipt = null;
    const r = await reconcile(key, job.id);
    expect(r.status).toBe(200);
    expect(r.json.job.status).toBe("settled");
    expect(r.json.job.tx).toBe(PAYRAIL_TX);
    expect(payrail.seen.length).toBe(2);
    expect(payrail.seen[1].signature).toEqual(payrail.seen[0].signature);
  });

  test("interrupt and resume, dead authorization: fails and releases the reservation", async () => {
    resetFake();
    const key = await makeKey();
    const before = await remaining(key);
    payrail.offer = { orderId: "order-t9", amountUsdCents: 100 };
    const started = await start(key, "order-t9", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    payrail.mode = "drop";
    const dropped = await sign(key, job.id, payloadFor(job));
    expect(dropped.json.job.status).toBe("settling");
    payrail.mode = "invalid";
    const r = await reconcile(key, job.id);
    expect(r.status).toBe(200);
    expect(r.json.job.status).toBe("failed");
    expect(r.json.job.error).toMatch(/invalid/);
    expect(await remaining(key)).toBe(before);
  });

  test("a job from another tenant answers 404, same as missing", async () => {
    resetFake();
    const key = await makeKey();
    payrail.offer = { orderId: "order-t10", amountUsdCents: 100 };
    const started = await start(key, "order-t10", 100);
    expect(started.status).toBe(201);
    const job = started.json.job;
    const other = await newTenant("market-stranger", "studio");
    const otherKey = await req("POST", "/api/grants", {
      token: other.token,
      body: { sub: "agent:stranger", caps: ["payments.x402", "grant.read"], ttlSec: 600, budget: { usd_cents: 1000, calls: 5, deploys: 0 }, constraints: {} },
    });
    expect(otherKey.status).toBe(201);
    expect((await get(otherKey.json.token, job.id)).status).toBe(404);
    expect((await reconcile(otherKey.json.token, job.id)).status).toBe(404);
  });

  test("start without the payments.x402 cap is refused", async () => {
    resetFake();
    const r = await req("POST", "/api/grants", {
      token: tenant.token,
      body: { sub: "agent:nocap", caps: ["grant.read"], ttlSec: 600, budget: { usd_cents: 1000, calls: 5, deploys: 0 }, constraints: {} },
    });
    expect(r.status).toBe(201);
    payrail.offer = { orderId: "order-t11", amountUsdCents: 100 };
    expect((await start(r.json.token, "order-t11", 100)).status).toBe(403);
  });
});
