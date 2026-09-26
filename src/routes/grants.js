// Routes: grant-holder API: grants, cog, deploys, ledger, events, tenant. Registration order is significant.
import { HttpError, parseJson } from "../util.js";
import { getGrant, recordEvent, sql } from "../db.js";
import { normalizeUsage, remainingBudget, TIERS } from "../policy.js";
import { issueChildGrant, revokeGrantTree, settleGrantUsage } from "../grants.js";
import { deleteDeploy, deployWorker, refreshDeployStatus, restartDeploy, TEMPLATES } from "../railway.js";
import { cogExecute, cogPlan } from "../cog.js";
import { app, readJsonBody, requireGrant } from "../http.js";

app.get("/api/grants/verify", requireGrant(null), (e) => {
  let t = e.get("auth");
  return e.json({
    id: t.row.id,
    tenant: t.tenant.id,
    tier: t.tenant.tier,
    sub: t.row.sub,
    depth: t.row.depth,
    caps: parseJson(t.row.caps),
    scope: parseJson(t.row.scope),
    constraints: parseJson(t.row.constraints),
    budget: parseJson(t.row.budget),
    remaining: remainingBudget(t.row),
    exp: Number(t.row.exp),
  });
});
// 0.3.2: a holder settles usage against its OWN grant. This is how a capability
// service that holds no signing key (lsp-mcp) charges a call: verify, then settle
// with the same token. 402 when the budget is gone; only the caller's budget moves.
app.post("/api/grants/settle", requireGrant(null), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new HttpError(400, "bad_body");
  let n = normalizeUsage({
      usd_cents: a.usd_cents,
      calls: a.calls,
      deploys: a.deploys,
    }),
    r = String(a.ref ?? "self");
  if (n.calls === 0) throw new HttpError(400, "nothing_to_settle");
  // Self-settle meters CALLS only. Money and deploys are charged by the runtime's own
  // executors; a holder writing those into the ledger would be bookkeeping fiction.
  if (n.usd_cents !== 0 || n.deploys !== 0) throw new HttpError(400, "calls_only");
  if (!/^[a-z0-9:_.-]{1,120}$/i.test(r)) throw new HttpError(400, "bad_ref");
  return (
    await settleGrantUsage(t.row.id, n, r, String(a.note || "settled by holder").slice(0, 200), "self-settle"),
    e.json({
      ok: !0,
      settled: n,
      remaining: remainingBudget(await getGrant(t.row.id)),
    })
  );
});
app.post("/api/grants", requireGrant("grant.issue"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e),
    n = await issueChildGrant(t.row, a, t.row.sub);
  return e.json(
    {
      id: n.row.id,
      token: n.token,
      sub: n.row.sub,
      caps: parseJson(n.row.caps),
      budget: parseJson(n.row.budget),
      exp: Number(n.row.exp),
      parent: t.row.id,
    },
    201,
  );
});
app.get("/api/grants", requireGrant("grant.read"), async (e) => {
  let t = e.get("auth"),
    a =
      await sql`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT id, parent, depth, sub, status, caps, budget, reserved, settled, exp, created_at FROM sub ORDER BY depth, created_at`;
  return e.json({
    grants: a.map((n) => ({
      ...n,
      exp: Number(n.exp),
      remaining: remainingBudget(n),
    })),
  });
});
app.get("/api/grants/:id", requireGrant("grant.read"), async (e) => {
  let t = e.get("auth"),
    a = await getGrant(e.req.param("id"));
  if (!a || a.tenant !== t.tenant.id) throw new HttpError(404, "grant_not_found");
  let { payload: n, ...r } = a;
  return e.json({
    grant: {
      ...r,
      exp: Number(r.exp),
      remaining: remainingBudget(a),
    },
  });
});
app.post("/api/grants/:id/revoke", requireGrant("grant.issue"), async (e) => {
  let t = e.get("auth"),
    a = e.req.param("id");
  if (
    !(
      await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id) SELECT 1 FROM sub WHERE id = ${a}`
    ).length
  )
    throw new HttpError(403, "not_in_subtree");
  return e.json({
    revoked: await revokeGrantTree(
      a,
      String((await readJsonBody(e)).reason || "revoked by " + t.row.sub),
      t.row.sub,
    ),
  });
});
app.post("/api/cog/plan", requireGrant("cog.plan"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.intent || typeof a.intent !== "string") throw new HttpError(400, "intent_required");
  return e.json({
    proposal: await cogPlan(t, a.intent.slice(0, 2000), a.hints || {}),
  });
});
app.post("/api/cog/execute", requireGrant("cog.execute"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.proposal) throw new HttpError(400, "proposal_required");
  return e.json(await cogExecute(t, a.proposal, !!a.confirm));
});
app.get("/api/cog/templates", requireGrant("cog.plan"), (e) =>
  e.json({
    templates: Object.fromEntries(
      Object.entries(TEMPLATES).map(([t, a]) => [
        t,
        {
          desc: a.desc,
          needs: a.needs,
          estCents: a.estCents,
          image: a.image,
        },
      ]),
    ),
  }),
);
app.post("/api/deploys", requireGrant("deploy.worker"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  return e.json(await deployWorker(t, a, !!a.confirm, t.row.sub), 201);
});
app.get("/api/deploys", requireGrant("worker.status"), async (e) => {
  let t = e.get("auth");
  return e.json({
    deploys:
      await sql`SELECT id, grant_id, name, template, status, executed, target, created_at, updated_at FROM deploys WHERE tenant = ${t.tenant.id} ORDER BY created_at DESC LIMIT 100`,
  });
});
app.get("/api/deploys/:id", requireGrant("worker.status"), async (e) => {
  let t = e.get("auth");
  return e.json({
    deploy: await refreshDeployStatus(t, e.req.param("id")),
  });
});
app.post("/api/deploys/:id/restart", requireGrant("worker.restart"), async (e) => {
  let t = e.get("auth");
  return e.json(await restartDeploy(t, e.req.param("id"), t.row.sub));
});
app.delete("/api/deploys/:id", requireGrant("worker.delete"), async (e) => {
  let t = e.get("auth");
  return e.json(await deleteDeploy(t, e.req.param("id"), t.row.sub));
});
app.get("/api/ledger", requireGrant("ledger.read"), async (e) => {
  let t = e.get("auth");
  return e.json({
    ledger: await sql`SELECT * FROM ledger WHERE tenant = ${t.tenant.id} ORDER BY id DESC LIMIT 200`,
  });
});
app.get("/api/events", requireGrant("tenant.read"), async (e) => {
  let t = e.get("auth");
  return e.json({
    events: await sql`SELECT * FROM events WHERE tenant = ${t.tenant.id} ORDER BY id DESC LIMIT 200`,
  });
});
app.post("/api/events", requireGrant("webhook.emit"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (!a.type) throw new HttpError(400, "type_required");
  return (
    await recordEvent(`agent.${String(a.type).slice(0, 60)}`, a.data ?? {}, t.tenant.id, t.row.sub),
    e.json(
      {
        ok: !0,
      },
      201,
    )
  );
});
app.get("/api/tenant", requireGrant("tenant.read"), (e) => {
  let t = e.get("auth"),
    { stripe_customer: a, stripe_subscription: n, ...r } = t.tenant;
  return e.json({
    tenant: r,
    tier: TIERS[r.tier],
  });
});
