// The human pages (src/ui, 2026-10-30): the Runtime Browser at "/", the loop, the card and the invite ship in
// the bundle, so git == live. The old cockpit was a database doc (`_cockpit`); nothing reads it any more.
// Also the read-only seal list the Runtime Browser shows: GET /api/admin/approvals.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported, and
// runtime.test.js already holds that boot.
import { describe, test, expect, afterAll } from "bun:test";
import { req, admin, newTenant, shutdown, dbQuery, ADMIN_KEY } from "./harness.js";

afterAll(shutdown);

describe("pages: the repo's pages, not the database's", () => {
  test("/, /loop, /card, /invite: public, uncached, the shared look and kit filled in", async () => {
    for (const [path, mark] of [["/", "THE MESH BROWSER"], ["/loop", "A WORLD · LIVE LOOP"], ["/card", "CARDS · A2A"], ["/invite", "You're invited to the Mesh."]]) {
      const r = await req("GET", path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.text).toContain(mark);
      expect(r.text).toContain("--accent:#36e0c8"); // look.css was inlined
      expect(r.text).not.toContain("/*LOOK*/");
      expect(r.text).not.toContain("/*KIT*/");
    }
    expect((await req("GET", "/loop")).text).toContain("function readMesh"); // kit.js was inlined
  });

  test("a _cockpit doc in the database no longer takes over /", async () => {
    await admin("PUT", "/api/admin/docs/_cockpit", { raw: "<p>old cockpit</p>" });
    const home = await req("GET", "/");
    expect(home.text).not.toContain("<p>old cockpit</p>");
    expect(home.text).toContain("THE MESH BROWSER");
    expect((await req("GET", "/docs/_cockpit")).status).toBe(404);
  });

  test("the page holds no secret: sign-in is Face ID at id, or the key once into a session", async () => {
    const home = (await req("GET", "/")).text;
    expect(home).not.toContain(ADMIN_KEY);
    expect(home).toContain("/sso/start?return=");
    expect(home).toContain("/api/admin/session");
  });

  test("old cockpit links still land on the Runtime Browser", async () => {
    const r = await req("GET", "/cockpit/grants");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/#/grants");
  });

  test("the connector hand-off is kept: same gate allow-list, same limited grant", async () => {
    const home = (await req("GET", "/")).text;
    expect(home).toContain('const GATES = ["https://mcp-gate-production.up.railway.app"]');
    expect(home).toContain('sub: "connector:claude", caps: ["memory.read", "memory.write", "cog.plan"]');
    expect(home).toContain("deploys: 0");
  });
});

describe("admin approvals: the seal list", () => {
  test("owner-only, pending by default, intent redacted, status checked", async () => {
    const t = await newTenant("seal-view");
    const id = "ap_seal_" + Date.now();
    await dbQuery(
      "INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, status) VALUES ($1, $2, $3, 'deploy', $4::jsonb, 1, 'pending')",
      [id, t.id, t.grantId, JSON.stringify({ template: "tip-alert-bot", env: { STRIPE_KEY: "sk_live_should_not_leak" } })],
    );
    expect((await req("GET", "/api/admin/approvals")).status).toBe(401);
    expect((await req("GET", "/api/admin/approvals", { token: t.token })).status).toBe(401);
    const r = await admin("GET", "/api/admin/approvals");
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("pending");
    const row = r.json.approvals.find((a) => a.id === id);
    expect(row.tenant).toBe(t.id);
    expect(row.intent.template).toBe("tip-alert-bot");
    expect(Object.keys(row.intent.env)).toEqual(["STRIPE_KEY"]);
    expect(r.text).not.toContain("sk_live_should_not_leak");
    expect((await admin("GET", "/api/admin/approvals?status=approved")).json.approvals.find((a) => a.id === id)).toBeUndefined();
    expect((await admin("GET", "/api/admin/approvals?status=all")).json.approvals.find((a) => a.id === id)).toBeTruthy();
    expect((await admin("GET", "/api/admin/approvals?status=nope")).status).toBe(400);
  });

  test("the owner still decides with the world's root grant, as before", async () => {
    const t = await newTenant("seal-decide");
    const id = "ap_seal_d_" + Date.now();
    await dbQuery("INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, status) VALUES ($1, $2, $3, 'deploy', '{}'::jsonb, 1, 'pending')", [id, t.id, t.grantId]);
    const d = await req("POST", `/api/approvals/${id}`, { token: t.token, body: { decision: "deny" } });
    expect(d.status).toBe(200);
    expect(d.json.status).toBe("denied");
    expect((await admin("GET", "/api/admin/approvals")).json.approvals.find((a) => a.id === id)).toBeUndefined();
  });
});
