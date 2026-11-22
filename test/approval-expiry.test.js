// Asks that can never run stop waiting on the owner (grants.js expireDeadApprovals, run by the reaper and by
// POST /api/admin/grants/reap). A pending approval whose agent's grant has ended, whose tenant is no longer
// active, or whose plan cheque is past its date is closed as `expired` with the reason and an event. A live
// ask is never touched; an ask the owner decided first is never decided twice.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll } from "bun:test";
import { req, admin, newTenant, dbQuery, shutdown } from "./harness.js";

afterAll(shutdown);

const now = () => Math.floor(Date.now() / 1000);
// An agent at autonomy "ask" asks to open a small escrow: the runtime files an approval for the owner.
async function ask(name, { ttlSec = 3600 } = {}) {
  const t = await newTenant(name, "pro");
  const g = await req("POST", "/api/grants", {
    token: t.token,
    body: { sub: "agent:asker", caps: ["escrow.hold", "grant.read"], ttlSec, budget: { usd_cents: 500, calls: 5, deploys: 0 }, constraints: { autonomy: "ask" } },
  });
  expect(g.status).toBe(201);
  const d = await req("POST", "/api/escrow", {
    token: g.json.token,
    body: { amount: 5, payee_tenant: "t_payee", payee_ref: "agent:q", condition: { kind: "attestation:self-settle" }, deadline: now() + 600 },
  });
  if (d.status !== 202) throw new Error("ask refused: " + d.status + " " + d.text);
  return { t, grantId: g.json.id, approval: d.json.approval.id };
}
const status = async (id) => (await dbQuery("SELECT status, result FROM approvals WHERE id = $1", [id])).rows[0];
const reap = async () => (await admin("POST", "/api/admin/grants/reap")).json.approvals_expired;
const events = async (id) =>
  (await dbQuery("SELECT data FROM events WHERE type = 'autonomy.expired' AND data->>'approval' = $1", [id])).rows.map((r) => r.data);

describe("dead approvals expire on their own", () => {
  test("a live ask is never touched", async () => {
    const a = await ask("ap-live");
    expect((await reap()).map((x) => x.id)).not.toContain(a.approval);
    expect((await status(a.approval)).status).toBe("pending");
  });

  test("the agent's grant was revoked: expired, with the reason and one event", async () => {
    const a = await ask("ap-revoked");
    await admin("POST", `/api/admin/grants/${a.grantId}/revoke`, { body: { reason: "test" } });
    expect(await reap()).toContainEqual({ id: a.approval, reason: "requesting_grant_revoked" });
    expect(await status(a.approval)).toEqual({ status: "expired", result: { reason: "requesting_grant_revoked" } });
    expect(await events(a.approval)).toEqual([{ approval: a.approval, action: "escrow.open", reason: "requesting_grant_revoked" }]);
    // a second pass changes nothing
    expect((await reap()).map((x) => x.id)).not.toContain(a.approval);
    expect((await events(a.approval)).length).toBe(1);
  });

  test("the agent's grant ran out: expired", async () => {
    const a = await ask("ap-ran-out");
    await dbQuery("UPDATE grants SET exp = $1 WHERE id = $2", [now() - 5, a.grantId]);
    const out = await reap();
    expect(out.find((x) => x.id === a.approval)?.reason).toMatch(/^requesting_grant_(expired|revoked)$/); // the reaper may end the grant first
    expect((await status(a.approval)).status).toBe("expired");
  });

  test("the tenant was suspended (the Oct 27 test asks): expired as tenant_not_active", async () => {
    const a = await ask("ap-suspended");
    await admin("POST", `/api/tenants/${a.t.id}/suspend`);
    expect(await reap()).toContainEqual({ id: a.approval, reason: "tenant_not_active" });
    expect((await status(a.approval)).status).toBe("expired");
  });

  test("a plan cheque past its date: expired as cheque_expired", async () => {
    const a = await ask("ap-cheque");
    await dbQuery("UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE id = $1", [a.approval]);
    expect(await reap()).toContainEqual({ id: a.approval, reason: "cheque_expired" });
  });

  test("an ask the owner already decided is never decided again", async () => {
    const a = await ask("ap-decided");
    const no = await req("POST", `/api/approvals/${a.approval}`, { token: a.t.token, body: { decision: "deny" } });
    expect(no.json.status).toBe("denied");
    await admin("POST", `/api/admin/grants/${a.grantId}/revoke`, { body: { reason: "test" } });
    expect((await reap()).map((x) => x.id)).not.toContain(a.approval);
    expect((await status(a.approval)).status).toBe("denied");
  });

  test("with the kill switch on, a live ask still waits; an expired one cannot be approved", async () => {
    const live = await ask("ap-kill-live");
    const dead = await ask("ap-kill-dead");
    await admin("POST", `/api/admin/grants/${dead.grantId}/revoke`, { body: { reason: "test" } });
    await admin("POST", "/api/admin/kill");
    try {
      await reap();
      expect((await status(live.approval)).status).toBe("pending");
      expect((await status(dead.approval)).status).toBe("expired");
    } finally {
      await admin("POST", "/api/admin/resume");
    }
    const late = await req("POST", `/api/approvals/${dead.approval}`, { token: dead.t.token, body: { decision: "approve" } });
    expect(late.status).toBe(404);
    expect(late.json.error).toBe("approval_not_pending");
  });

  test("the owner's list no longer shows them as pending", async () => {
    const pending = (await admin("GET", "/api/admin/approvals")).json.approvals.filter((a) => a.status === "pending").map((a) => a.id);
    const expired = (await dbQuery("SELECT id FROM approvals WHERE status = 'expired'")).rows.map((r) => r.id);
    expect(expired.length).toBeGreaterThanOrEqual(5);
    for (const id of expired) expect(pending).not.toContain(id);
  });
});
