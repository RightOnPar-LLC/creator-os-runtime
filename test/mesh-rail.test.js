// The MeshMarket rail (src/meshmarket.js, src/routes/payments.js): an agent buys one MeshMarket
// capability out of its own grant budget. Reserve the ceiling, call with the job id as the
// idempotency key, then settle exactly what MeshMarket kept and give the rest back — for an
// instant listing at once, for a pay-on-proof listing when the hold resolves.
//
// Driven against the fake MeshMarket in harness.js, which behaves like the real exchange on these
// paths (idempotent replay, x-max-price, holds, accept, provider_failed with refunded true/false).
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll } from "bun:test";
import { req, admin, newTenant, dbQuery, shutdown, meshmarket } from "./harness.js";

afterAll(shutdown);

const BUY = "/api/payments/meshmarket/jobs";
// Each call gets its own parent tenant unless one is passed: a pro root hands out 5000 in all,
// and one shared root would run dry long before the suite ends.
let seq = 0;
const mint = async (root, { caps = ["payments.meshmarket", "grant.read"], budget = 500, constraints = {} } = {}) => {
  root ??= await newTenant("mm-buyer-" + ++seq, "pro");
  const r = await req("POST", "/api/grants", {
    token: root.token,
    body: { sub: "agent:buyer", caps, ttlSec: 3600, budget: { usd_cents: budget, calls: 5, deploys: 0 }, constraints },
  });
  expect(r.status).toBe(201);
  return r.json.token;
};
const left = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining.usd_cents;
const buy = (token, body) => req("POST", BUY, { token, body: { slug: "test-tool", input: { q: "hi" }, maxPrice: 20, ...body } });
const get = (token, id) => req("GET", `${BUY}/${id}`, { token });
const sweep = () => admin("POST", "/api/admin/meshmarket/sweep");
const ledger = async (ref) => (await dbQuery("SELECT kind, usd_cents FROM ledger WHERE ref = $1 ORDER BY id", [ref])).rows;
const holdOf = (job) => meshmarket.holds[job.receipt.hold_id];

describe("MeshMarket rail", () => {
  let root;

  test("before the buyer account is enrolled, a purchase is refused and nothing is reserved", async () => {
    root = await newTenant("mm-rail", "pro");
    const k = await mint();
    const r = await buy(k);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("meshmarket_unenrolled");
    expect(await left(k)).toBe(500);
    expect((await sweep()).json.skipped).toBe("unenrolled");
    expect(meshmarket.calls.length).toBe(0);
  });

  test("enrolment is the owner's alone; the key is sealed in the vault and never handed back", async () => {
    expect((await req("POST", "/api/admin/meshmarket/enroll", { body: { handle: "runtime-buyer" } })).status).toBe(401);
    const k = await mint();
    expect((await req("POST", "/api/admin/meshmarket/enroll", { token: k, body: { handle: "runtime-buyer" } })).status).toBe(401);
    expect((await admin("POST", "/api/admin/meshmarket/enroll", { body: { handle: "x" } })).json.error).toBe("handle_invalid");
    const r = await admin("POST", "/api/admin/meshmarket/enroll", { body: { handle: "runtime-buyer" } });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ enrolled: true, handle: "runtime-buyer", credits: 250 });
    expect(JSON.stringify(r.json)).not.toContain(meshmarket.key);
    const stored = (await dbQuery("SELECT value FROM settings WHERE key = 'meshmarket_key'")).rows[0].value;
    expect(stored).not.toContain(meshmarket.key);
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual(["ciphertext", "iv", "tag"]);
    const st = await admin("GET", "/api/admin/meshmarket");
    expect(st.json).toMatchObject({ enrolled: true, handle: "runtime-buyer", reachable: true, credits: 250 });
    expect(JSON.stringify(st.json)).not.toContain(meshmarket.key);
    expect((await admin("POST", "/api/admin/meshmarket/enroll", { body: { handle: "another" } })).status).toBe(409);
    expect((await dbQuery("SELECT count(*)::int AS n FROM events WHERE type = 'meshmarket.enrolled'")).rows[0].n).toBe(1);
  });

  test("a grant without payments.meshmarket cannot buy (an x402 key included)", async () => {
    for (const caps of [["grant.read"], ["payments.x402", "grant.read"]]) {
      const k = await mint(undefined, { caps });
      expect((await buy(k)).status).toBe(403);
      expect(await left(k)).toBe(500);
    }
  });

  test("bad requests are refused before anything is reserved", async () => {
    const k = await mint();
    expect((await buy(k, { slug: "Bad Slug!" })).json.error).toBe("bad_slug");
    expect((await buy(k, { maxPrice: 0 })).json.error).toBe("bad_max_price");
    expect((await buy(k, { maxPrice: 2.5 })).json.error).toBe("bad_max_price");
    expect((await buy(k, { input: { blob: "x".repeat(20000) } })).status).toBe(413);
    expect(await left(k)).toBe(500);
  });

  test("instant listing: reserve the ceiling, call once, settle what was charged, return the rest", async () => {
    meshmarket.mode = "instant";
    meshmarket.price = 20;
    const k = await mint();
    const before = meshmarket.charges;
    const r = await buy(k, { maxPrice: 30 });
    expect(r.status).toBe(201);
    const job = r.json.job;
    expect(job.status).toBe("settled");
    expect(job.receipt.spent).toBe(20);
    expect(meshmarket.charges).toBe(before + 1);
    const sent = meshmarket.calls.at(-1);
    expect(sent).toEqual({ slug: "test-tool", idem: job.id, max: 30 }); // the job id IS the idempotency key
    expect(await left(k)).toBe(480);
    expect(await ledger(job.id)).toEqual([{ kind: "reserve", usd_cents: 30 }, { kind: "release", usd_cents: -10 }]);
    expect(await ledger(job.tx)).toEqual([{ kind: "meshmarket-settle", usd_cents: 20 }]);
    expect((await get(k, job.id)).json.job.status).toBe("settled");
  });

  test("a price above the ceiling is refused by MeshMarket: nothing charged, the budget is whole", async () => {
    meshmarket.mode = "instant";
    meshmarket.price = 20;
    const k = await mint();
    const before = meshmarket.charges;
    const job = (await buy(k, { maxPrice: 10 })).json.job;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("price_above_max");
    expect(meshmarket.charges).toBe(before);
    expect(await left(k)).toBe(500);
  });

  test("pay-on-proof listing: held while MeshMarket holds it; accepted, then settled once", async () => {
    meshmarket.mode = "hold";
    meshmarket.price = 20;
    const k = await mint();
    const job = (await buy(k)).json.job;
    expect(job.status).toBe("held");
    expect(job.receipt.hold_id).toBeTruthy();
    expect(await left(k)).toBe(480); // reserved, not yet spent
    expect((await req("POST", `${BUY}/${job.id}/reconcile`, { token: k })).json.job.status).toBe("held"); // still held on MeshMarket
    const acc = await req("POST", `${BUY}/${job.id}/accept`, { token: k });
    expect(acc.json.job.status).toBe("settled");
    expect(acc.json.job.receipt.spent).toBe(20);
    expect(acc.json.job.receipt.outcome).toBe("released");
    expect(holdOf(job).state).toBe("released");
    expect(await left(k)).toBe(480);
    // A second accept and a sweep change nothing.
    expect((await req("POST", `${BUY}/${job.id}/accept`, { token: k })).status).toBe(409);
    await sweep();
    expect(await ledger(job.tx)).toEqual([{ kind: "meshmarket-settle", usd_cents: 20 }]);
  });

  test("held, then refunded on MeshMarket: the sweep gives the whole reservation back", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    holdOf(job).state = "refunded";
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.status).toBe("refunded");
    expect(now.receipt.spent).toBe(0);
    expect(await left(k)).toBe(500);
  });

  test("held, then split 40/60 by a verdict: spent is MeshMarket's own gross, floor(20 x 40 / 100) = 8", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    Object.assign(holdOf(job), { state: "split", provider_share: 40, verdict: "split" });
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.status).toBe("settled");
    expect(now.receipt.spent).toBe(8);
    expect(await left(k)).toBe(492);
  });

  test("released by a verdict against a dispute: the forfeited stake is spent too", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    Object.assign(holdOf(job), { state: "released", verdict: "release", stake: 2 });
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.receipt.spent).toBe(22);
    expect(await left(k)).toBe(478);
  });

  test("CONTROL: the answer is lost after MeshMarket charged — the sweep re-sends the SAME key, MeshMarket replays, one charge", async () => {
    meshmarket.mode = "drop";
    const k = await mint();
    const before = meshmarket.charges;
    const job = (await buy(k)).json.job;
    expect(job.status).toBe("calling"); // the runtime does not know yet: nothing settled, nothing released
    expect(meshmarket.charges).toBe(before + 1);
    expect(await left(k)).toBe(480);
    meshmarket.mode = "instant";
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.status).toBe("settled");
    expect(meshmarket.charges).toBe(before + 1); // replayed, never charged twice
    expect(meshmarket.calls.filter((c) => c.idem === job.id).length).toBe(2);
    expect(await left(k)).toBe(480);
  });

  test("a provider failure that MeshMarket refunded: the job fails and the budget comes back", async () => {
    meshmarket.mode = "fail";
    const k = await mint();
    const job = (await buy(k)).json.job;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("provider_failed");
    expect(await left(k)).toBe(500);
  });

  test("CONTROL: a provider failure MeshMarket could NOT refund stops in review, reservation kept, event raised", async () => {
    meshmarket.mode = "fail_unrefunded";
    const k = await mint();
    const job = (await buy(k)).json.job;
    expect(job.status).toBe("review");
    expect(job.error).toBe("meshmarket_refund_failed");
    expect(await left(k)).toBe(480); // the money may be gone on MeshMarket's side: never guessed back
    await sweep();
    expect((await get(k, job.id)).json.job.status).toBe("review"); // the sweep leaves it for a person
    expect((await dbQuery("SELECT count(*)::int AS n FROM events WHERE type = 'payment.meshmarket.review' AND data->>'id' = $1", [job.id])).rows[0].n).toBe(1);
  });

  test("CONTROL: MeshMarket down — nothing moves; after 30 unanswered tries the job stops in review", async () => {
    meshmarket.mode = "down";
    const k = await mint();
    const before = meshmarket.charges;
    const job = (await buy(k)).json.job;
    expect(job.status).toBe("calling");
    expect(job.receipt.attempts).toBe(1);
    for (let i = 0; i < 28; i++) await sweep();
    expect((await get(k, job.id)).json.job.status).toBe("calling");
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.status).toBe("review");
    expect(now.error).toBe("no_answer_after_30_attempts");
    expect(meshmarket.charges).toBe(before);
    expect(await left(k)).toBe(480);
    meshmarket.mode = "instant";
  });

  test("CONTROL: the kill switch stops the sweep; resumed, the held job settles", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    holdOf(job).state = "released";
    await admin("POST", "/api/admin/kill");
    try {
      expect((await sweep()).json.skipped).toBe("kill_switch_on");
      expect((await dbQuery("SELECT status FROM payment_jobs WHERE id = $1", [job.id])).rows[0].status).toBe("held");
    } finally {
      await admin("POST", "/api/admin/resume");
    }
    await sweep();
    expect((await get(k, job.id)).json.job.status).toBe("settled");
  });

  test("another tenant's job does not exist for you: read, reconcile and accept are all 404", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    const other = await mint(await newTenant("mm-stranger", "pro"));
    expect((await get(other, job.id)).status).toBe(404);
    expect((await req("POST", `${BUY}/${job.id}/reconcile`, { token: other })).status).toBe(404);
    expect((await req("POST", `${BUY}/${job.id}/accept`, { token: other })).status).toBe(404);
  });

  test("the x402 routes never touch a MeshMarket job (404), and vice versa", async () => {
    meshmarket.mode = "instant";
    const k = await mint(undefined, { caps: ["payments.meshmarket", "payments.x402", "grant.read"] });
    const job = (await buy(k)).json.job;
    expect((await req("GET", `/api/payments/x402/jobs/${job.id}`, { token: k })).status).toBe(404);
    expect((await req("POST", `/api/payments/x402/jobs/${job.id}/reconcile`, { token: k })).status).toBe(404);
    expect((await req("POST", `/api/payments/x402/jobs/${job.id}/sign`, { token: k, body: { paymentPayload: {} } })).status).toBe(404);
  });

  test("an agent whose dial says ask: an approval is filed and nothing is reserved; the owner approves and it runs", async () => {
    meshmarket.mode = "instant";
    const owner = await newTenant("mm-owner", "pro");
    const k = await mint(owner, { constraints: { autonomy: "ask" } });
    const before = meshmarket.charges;
    const d = await buy(k);
    expect(d.status).toBe(202);
    expect(d.json.approval.action).toBe("payment.meshmarket");
    expect(await left(k)).toBe(500);
    expect(meshmarket.charges).toBe(before);
    const ok = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: owner.token, body: { decision: "approve" } });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("executed");
    expect(ok.json.result.job.status).toBe("settled");
    expect(meshmarket.charges).toBe(before + 1);
    expect(await left(k)).toBe(480);
  });

  test("status counts the jobs by state", async () => {
    const st = (await admin("GET", "/api/admin/meshmarket")).json;
    expect(st.jobs.settled).toBeGreaterThanOrEqual(6);
    expect(st.jobs.review).toBe(2);
  });
});
