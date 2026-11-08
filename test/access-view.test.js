import { describe, test, expect, afterAll } from "bun:test";
import { req, admin, newTenant, shutdown, dbQuery } from "./harness.js";

afterAll(shutdown);

describe("access view", () => {
  test("the signed-out guide is bundled and the browser scripts parse", async () => {
    const { text } = await req("GET", "/");
    expect(text).toContain("How Runtime works");
    expect(text).toContain("Account unverified");
    expect(text).toContain("Access history");
    for (const [, script] of text.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  test("owner-only pages separate elapsed grants, show recorded provenance and link authorized receipts", async () => {
    const t = await newTenant("access-workspace");
    const child = await req("POST", "/api/grants", { token: t.token, body: {
      sub: "agent:claude", caps: ["grant.read"], ttlSec: 300,
    } });
    expect(child.status).toBe(201);
    const id = child.json.id;
    const receipt = "tr_access_allowed_" + id;
    await dbQuery("INSERT INTO agents (tenant, sub, owner, sponsor) VALUES ($1, 'agent:claude', 'Operations team', 'Review lead')", [t.id]);
    await dbQuery("INSERT INTO tool_receipts (id, tenant, grant_id, tool, auth_decision, started_at) VALUES ($1, $2, $3, 'grant_list', 'authorized', now() - interval '1 minute'), ($4, $2, $3, 'grant_list', 'denied', now())", [receipt, t.id, id, "tr_access_denied_" + id]);
    const path = "/api/admin/grants?access=active&tenant=" + t.id;
    expect((await req("GET", path)).status).toBe(401);
    expect((await req("GET", path, { token: t.token })).status).toBe(401);
    const filtered = await admin("GET", path + "&search=operations&limit=1");
    expect(filtered.status).toBe(200);
    expect(filtered.json.total).toBe(1);
    expect(filtered.json.grants[0]).toMatchObject({
      id, issued_by: "tenant:root", workspace_name: "access-workspace",
      seat_owner: "Operations team", seat_sponsor: "Review lead", last_receipt_id: receipt,
    });
    expect(filtered.json.grants[0].last_used_at).toBeTruthy();
    const receiptPath = "/api/admin/tool-receipts?id=" + receipt;
    expect((await req("GET", receiptPath)).status).toBe(401);
    expect((await admin("GET", receiptPath)).json.receipts.map((r) => r.id)).toEqual([receipt]);
    await dbQuery("UPDATE grants SET exp = 1 WHERE id = $1", [id]);
    expect((await admin("GET", path)).json.grants.map((r) => r.id)).toEqual([t.grantId]);
    const history = await admin("GET", "/api/admin/grants?access=history&tenant=" + t.id);
    expect(history.json.total).toBe(1);
    expect(history.json.grants.map((r) => r.id)).toEqual([id]);
  });
});
