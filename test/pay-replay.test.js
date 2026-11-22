// The PAY daily replay (deploy/box/pay-replay.mjs) against the runtime and the fake MeshMarket:
// green when every number agrees; red, and nothing guessed, when MeshMarket refuses or fails;
// skipped (not red) while the kill switch is on; the day's grants are always revoked.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll } from "bun:test";
import { BASE, ADMIN_KEY, admin, newTenant, dbQuery, shutdown, meshmarket } from "./harness.js";
import { replay } from "../deploy/box/pay-replay.mjs";

afterAll(shutdown);
const run = (opts = {}) => replay({ base: BASE, adminKey: ADMIN_KEY, ...opts });
const failed = (r) => r.checks.filter((c) => !c.pass).map((c) => c.name);
const liveReplayRoots = async () =>
  (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE sub = 'tenant:pay-replay' AND status = 'active'")).rows[0].n;

describe("PAY daily replay", () => {
  test("red before the buyer account exists; nothing is bought", async () => {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["buyer account enrolled and reachable"]);
    expect(meshmarket.charges).toBe(0);
  });

  test("red without the proof tenant", async () => {
    expect((await admin("POST", "/api/admin/meshmarket/enroll", { body: { handle: "meshtool-runtime" } })).status).toBe(201);
    const r = await run();
    expect(failed(r)).toEqual(["proof tenant exists"]);
  });

  test("green: one purchase, every number agrees, the day's grants are revoked", async () => {
    await newTenant("pay-proof-rail", "pro");
    meshmarket.mode = "instant";
    meshmarket.price = 1;
    const before = meshmarket.charges;
    const r = await run();
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.spent).toBe(1);
    expect(meshmarket.charges).toBe(before + 1);
    expect(r.checks.map((c) => c.name)).toEqual([
      "buyer account enrolled and reachable",
      "proof tenant exists",
      "root grant minted",
      "agent grant minted",
      "job settled",
      "spent equals what MeshMarket charged, within the ceiling",
      "agent budget dropped by exactly the spend",
      "ledger reads reserve / settle / release",
      "MeshMarket charged once, the same amount",
    ]);
    expect(await liveReplayRoots()).toBe(0);
    expect(JSON.stringify(r)).not.toContain(ADMIN_KEY);
    expect(JSON.stringify(r)).not.toContain(meshmarket.key);
  });

  test("CONTROL: the price rose above the ceiling: red, nothing charged", async () => {
    meshmarket.price = 5;
    const before = meshmarket.charges;
    const r = await run();
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["job settled"]);
    expect(r.job.error).toBe("price_above_max");
    expect(meshmarket.charges).toBe(before);
    expect(await liveReplayRoots()).toBe(0);
    meshmarket.price = 1;
  });

  test("CONTROL: the provider failed (refunded): red", async () => {
    meshmarket.mode = "fail";
    const r = await run();
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["job settled"]);
    meshmarket.mode = "instant";
  });

  test("a low buyer balance is a notice, not a failure", async () => {
    meshmarket.credits = 20;
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.notices).toEqual(["buyer balance low: 19 MESH left"]);
  });

  test("kill switch on: skipped, nothing bought, not red", async () => {
    await admin("POST", "/api/admin/kill");
    try {
      const before = meshmarket.charges;
      const r = await run();
      expect(r).toMatchObject({ ok: true, skipped: "kill_switch_on" });
      expect(meshmarket.charges).toBe(before);
    } finally {
      await admin("POST", "/api/admin/resume");
    }
  });
});
