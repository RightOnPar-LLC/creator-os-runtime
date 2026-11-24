// The escrow capture switch (src/routes/admin.js): POST /api/admin/escrow-capture/on|off.
// Capture (POST /webhooks/mesh -> captureFromMeshReceipt) moves real value, so it is gated on the
// `escrow_capture` setting and OFF by default. Before these routes the gate could only be armed by a
// raw write to the settings table; this pins that the operator switch arms and disarms it, that only
// the admin can flip it, that overview reports it, and that every flip leaves an event.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported,
// with a fresh database, so the gate starts at its real default (never set = OFF).
import { describe, test, expect, afterAll } from "bun:test";
import { req, admin, hmacHex, newTenant, dbQuery, shutdown, MESH_SECRET } from "./harness.js";

afterAll(shutdown);

let capturedEscrow = null; // the hold captured while ON; OFF must leave it exactly as it was

const meshReceipt = (obj) => {
  const m = JSON.stringify(obj);
  return req("POST", "/webhooks/mesh", { raw: m, headers: { "x-mesh-signature": hmacHex(MESH_SECRET, m) } });
};
const openEscrow = (token, payee) =>
  req("POST", "/api/escrow", { token, body: { amount: 500, payee_tenant: payee, condition: { kind: "receipt:mesh" } } });
const state = async (token, gid) => (await req("GET", "/api/escrow/" + gid, { token })).json.escrow.state;
const credit = async (payee, esId) =>
  (await dbQuery("SELECT count(*)::int AS n, coalesce(sum(usd_cents),0)::int AS cents FROM ledger WHERE tenant=$1 AND kind='mesh-credit' AND ref=$2", [payee, esId])).rows[0];
const flips = async () =>
  (await dbQuery("SELECT type FROM events WHERE type IN ('escrow.capture_enabled','escrow.capture_disabled') ORDER BY id")).rows.map((r) => r.type);

describe("escrow capture switch", () => {
  test("only the admin can flip it: no key, a wrong key and a grant token are all refused", async () => {
    const t = await newTenant("sw-auth", "pro");
    for (const path of ["/api/admin/escrow-capture/on", "/api/admin/escrow-capture/off"]) {
      expect((await req("POST", path)).status).toBe(401);
      expect((await req("POST", path, { token: "not-the-key" })).status).toBe(401);
      expect((await req("POST", path, { token: t.token })).status).toBe(401);
    }
    expect(await flips()).toEqual([]); // a refused flip leaves no trace
  });

  test("default is OFF: overview says so and a signed receipt does not capture", async () => {
    expect((await admin("GET", "/api/admin/overview")).json.escrowCapture).toBe(false);
    const t = await newTenant("sw-default", "pro");
    const o = await openEscrow(t.token, "t_sw_default");
    expect(o.status).toBe(201);
    expect((await meshReceipt({ receipt_id: "sw-d1", escrow_id: o.json.escrow.id })).json.escrow).toBeNull();
    expect(await state(t.token, o.json.escrow.grant_id)).toBe("open");
  });

  test("ON arms capture: the next receipt captures exactly once and credits the payee", async () => {
    expect((await admin("POST", "/api/admin/escrow-capture/on")).json).toEqual({ escrowCapture: true });
    expect((await admin("GET", "/api/admin/overview")).json.escrowCapture).toBe(true);
    const t = await newTenant("sw-on", "pro");
    const o = await openEscrow(t.token, "t_sw_on");
    const esId = o.json.escrow.id, gid = o.json.escrow.grant_id;
    capturedEscrow = { esId, gid, token: t.token };
    expect((await meshReceipt({ receipt_id: "sw-on1", escrow_id: esId })).json.escrow.captured).toBe(true);
    expect(await state(t.token, gid)).toBe("captured");
    expect(await credit("t_sw_on", esId)).toEqual({ n: 1, cents: 500 });
    expect((await meshReceipt({ receipt_id: "sw-on2", escrow_id: esId })).json.escrow.captured).toBe(false);
    expect(await credit("t_sw_on", esId)).toEqual({ n: 1, cents: 500 });
  });

  test("OFF disarms at once: a new hold stays open, and nothing already captured changes", async () => {
    expect((await admin("POST", "/api/admin/escrow-capture/off")).json).toEqual({ escrowCapture: false });
    expect((await admin("GET", "/api/admin/overview")).json.escrowCapture).toBe(false);
    const t = await newTenant("sw-off", "pro");
    const o = await openEscrow(t.token, "t_sw_off");
    expect((await meshReceipt({ receipt_id: "sw-off1", escrow_id: o.json.escrow.id })).json.escrow).toBeNull();
    expect(await state(t.token, o.json.escrow.grant_id)).toBe("open");
    expect(await state(capturedEscrow.token, capturedEscrow.gid)).toBe("captured");
    expect(await credit("t_sw_on", capturedEscrow.esId)).toEqual({ n: 1, cents: 500 });
  });

  test("every flip is on the record, in order", async () => {
    expect(await flips()).toEqual(["escrow.capture_enabled", "escrow.capture_disabled"]);
  });
});
