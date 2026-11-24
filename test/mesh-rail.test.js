// The MeshMarket rail (src/meshmarket.js, src/routes/payments.js): an agent buys one MeshMarket
// capability out of its own grant budget. Reserve the ceiling, call with the job id as the
// idempotency key, then settle exactly what MeshMarket kept and give the rest back — for an
// instant listing at once, for a pay-on-proof listing when the hold resolves.
//
// Money: MeshMarket prices in MESH, budgets are real cents. At the default 1.2 MESH per cent
// (Starter pack, $5 = 600 MESH), rounded UP: a 20 MESH ceiling reserves 17 cents, 30 reserves 25.
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

  test("instant listing: reserve the ceiling in cents, call once, settle what was charged, return the rest", async () => {
    meshmarket.mode = "instant";
    meshmarket.price = 20;
    const k = await mint();
    const before = meshmarket.charges;
    const r = await buy(k, { maxPrice: 30 });
    expect(r.status).toBe(201);
    const job = r.json.job;
    expect(job.status).toBe("settled");
    expect(job.amount_usd_cents).toBe(25); // 30 MESH ceiling / 1.2, rounded up
    expect(job.receipt.spent_mesh).toBe(20);
    expect(job.receipt.spent).toBe(17); // 20 MESH / 1.2 = 16.67, rounded up
    expect(meshmarket.charges).toBe(before + 1);
    const sent = meshmarket.calls.at(-1);
    expect(sent).toEqual({ slug: "test-tool", idem: job.id, max: 30 }); // the job id IS the idempotency key
    expect(await left(k)).toBe(483);
    expect(await ledger(job.id)).toEqual([{ kind: "reserve", usd_cents: 25 }, { kind: "release", usd_cents: -8 }]);
    expect(await ledger(job.tx)).toEqual([{ kind: "meshmarket-settle", usd_cents: 17 }]);
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
    expect(await left(k)).toBe(483); // 17 reserved, not yet spent
    expect((await req("POST", `${BUY}/${job.id}/reconcile`, { token: k })).json.job.status).toBe("held"); // still held on MeshMarket
    const acc = await req("POST", `${BUY}/${job.id}/accept`, { token: k });
    expect(acc.json.job.status).toBe("settled");
    expect(acc.json.job.receipt.spent).toBe(17);
    expect(acc.json.job.receipt.spent_mesh).toBe(20);
    expect(acc.json.job.receipt.outcome).toBe("released");
    expect(holdOf(job).state).toBe("released");
    expect(await left(k)).toBe(483);
    // A second accept and a sweep change nothing.
    expect((await req("POST", `${BUY}/${job.id}/accept`, { token: k })).status).toBe(409);
    await sweep();
    expect(await ledger(job.tx)).toEqual([{ kind: "meshmarket-settle", usd_cents: 17 }]);
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

  test("held, then split 40/60 by a verdict: MeshMarket's own gross floor(20 x 40 / 100) = 8 MESH = 7 cents", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    Object.assign(holdOf(job), { state: "split", provider_share: 40, verdict: "split" });
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.status).toBe("settled");
    expect(now.receipt.spent_mesh).toBe(8);
    expect(now.receipt.spent).toBe(7);
    expect(await left(k)).toBe(493);
  });

  test("released by a verdict against a dispute: the forfeited stake is spent too, and spend above the reservation is never hidden", async () => {
    meshmarket.mode = "hold";
    const k = await mint();
    const job = (await buy(k)).json.job;
    Object.assign(holdOf(job), { state: "released", verdict: "release", stake: 2 });
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.receipt.spent_mesh).toBe(22);
    expect(now.receipt.spent).toBe(19); // 22 / 1.2 = 18.33, rounded up; 17 was reserved
    expect(now.receipt.over_reservation).toBe(2);
    expect(await left(k)).toBe(481);
    expect(await ledger(now.tx)).toEqual([{ kind: "meshmarket-settle", usd_cents: 17 }, { kind: "meshmarket-overage", usd_cents: 2 }]);
    expect((await dbQuery("SELECT count(*)::int AS n FROM events WHERE type = 'payment.meshmarket.overage' AND data->>'id' = $1", [job.id])).rows[0].n).toBe(1);
  });

  test("CONTROL: the answer is lost after MeshMarket charged — the sweep re-sends the SAME key, MeshMarket replays, one charge", async () => {
    meshmarket.mode = "drop";
    const k = await mint();
    const before = meshmarket.charges;
    const job = (await buy(k)).json.job;
    expect(job.status).toBe("calling"); // the runtime does not know yet: nothing settled, nothing released
    expect(meshmarket.charges).toBe(before + 1);
    expect(await left(k)).toBe(483);
    meshmarket.mode = "instant";
    await sweep();
    const now = (await get(k, job.id)).json.job;
    expect(now.status).toBe("settled");
    expect(meshmarket.charges).toBe(before + 1); // replayed, never charged twice
    expect(meshmarket.calls.filter((c) => c.idem === job.id).length).toBe(2);
    expect(await left(k)).toBe(483);
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
    expect(await left(k)).toBe(483); // the money may be gone on MeshMarket's side: never guessed back
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
    expect(await left(k)).toBe(483);
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
    expect(await left(k)).toBe(483);
  });

  test("a job keeps the rate it started with: a rate change never moves a job already open", async () => {
    meshmarket.mode = "hold";
    meshmarket.price = 20;
    const k = await mint();
    const job = (await buy(k)).json.job;
    expect(job.amount_usd_cents).toBe(17);
    process.env.MESHMARKET_MESH_PER_USD_CENT = "2";
    try {
      const acc = (await req("POST", `${BUY}/${job.id}/accept`, { token: k })).json.job;
      expect(acc.receipt.spent).toBe(17); // settled at 1.2, the job's own rate, not the new 2
      expect(await left(k)).toBe(483);
      const k2 = await mint();
      expect((await buy(k2, { maxPrice: 20, slug: "test-tool" })).json.job.amount_usd_cents).toBe(10); // new jobs: the new rate
    } finally {
      delete process.env.MESHMARKET_MESH_PER_USD_CENT;
    }
  });

  test("CONTROL: a rate that cannot be read refuses every purchase, nothing reserved", async () => {
    meshmarket.mode = "instant";
    const k = await mint();
    for (const bad of ["abc", "0", "-1"]) {
      process.env.MESHMARKET_MESH_PER_USD_CENT = bad;
      try {
        const r = await buy(k);
        expect(r.status).toBe(503);
        expect(r.json.error).toBe("meshmarket_rate_invalid");
      } finally {
        delete process.env.MESHMARKET_MESH_PER_USD_CENT;
      }
    }
    expect(await left(k)).toBe(500);
  });

  test("CONTROL: the runtime-wide daily cap refuses a purchase that would pass it, before any budget is reserved", async () => {
    meshmarket.mode = "instant";
    meshmarket.price = 20;
    const used = (await admin("GET", "/api/admin/meshmarket")).json.daily.used_mesh;
    expect(used).toBeGreaterThan(0);
    process.env.MESHMARKET_DAILY_CAP_MESH = String(used + 25);
    try {
      const k = await mint();
      const before = meshmarket.charges;
      expect((await buy(k, { maxPrice: 20 })).json.job.status).toBe("settled"); // used + 20 <= cap
      const r = await buy(k, { maxPrice: 20 }); // used + 40 > cap
      expect(r.status).toBe(429);
      expect(r.json.error).toBe("meshmarket_daily_cap");
      expect(meshmarket.charges).toBe(before + 1);
      expect(await left(k)).toBe(483); // only the first purchase moved the budget
      const st = (await admin("GET", "/api/admin/meshmarket")).json;
      expect(st.daily).toEqual({ cap_mesh: used + 25, used_mesh: used + 20 });
      expect((await dbQuery("SELECT count(*)::int AS n FROM events WHERE type = 'payment.meshmarket.daily_cap'")).rows[0].n).toBe(1);
      process.env.MESHMARKET_DAILY_CAP_MESH = "x"; // unreadable: nothing can be bought
      expect((await buy(k, { maxPrice: 1 })).status).toBe(429);
    } finally {
      process.env.MESHMARKET_DAILY_CAP_MESH = "100000";
    }
  });

  test("status counts the jobs by state and shows the rate and today's spend against the cap", async () => {
    const st = (await admin("GET", "/api/admin/meshmarket")).json;
    expect(st.jobs.settled).toBeGreaterThanOrEqual(6);
    expect(st.jobs.review).toBe(2);
    expect(st.mesh_per_cent).toBe(1.2);
    expect(st.daily.cap_mesh).toBe(100000);
    expect(st.daily.used_mesh).toBeGreaterThan(0);
  });
});
