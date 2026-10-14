// Routes: grant-holder API: grants, cog, deploys, ledger, events, tenant. Registration order is significant.
import { HttpError, nowSec, parseJson, withRedactedIntent } from "../util.js";
import { getGrant, getTenant, isKillSwitchOn, recordEvent, sql } from "../db.js";
import { normalizeUsage, remainingBudget, TIERS } from "../policy.js";
import { endedAbove, issueChildGrant, lowerGrantAutonomy, recordAutonomyRow, revokeGrantTree, settleGrantUsage } from "../grants.js";
import { HOST_DEFAULT_BUDGET, HOST_DEFAULT_CAPS, HOST_DEFAULTS, HOST_TIERS, hostLimits, hostName } from "../hostpolicy.js";
import { notATourReason } from "../tours.js";
import { AUTONOMY_LEVELS, autonomyOf } from "../autonomy.js";
import { openEscrow, serializeEscrow } from "../escrow.js";
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
  let reason = String((await readJsonBody(e)).reason || "revoked by " + t.row.sub);
  notATourReason(reason); // "tour: ..." is the runtime's own (tours.js): the alarm reads one of them back
  return e.json({ revoked: await revokeGrantTree(a, reason, t.row.sub) });
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
  // The stored intent's env values never leave (util.js redactIntent).
  return e.json({
    deploy: withRedactedIntent(await refreshDeployStatus(t, e.req.param("id"))),
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
  // SUBTREE-scoped, not tenant-wide: a caller sees only the ledger rows for its own
  // grant and its descendants (same recursive CTE /api/grants uses). For a normal
  // single-root tenant read by its root this is every row in the tenant (unchanged);
  // for a pooled leaf guest it is only the guest's own reserve/self-settle rows, so
  // one guest never sees another's spend. This is what lets ledger.read be a guest cap.
  return e.json({
    ledger:
      await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
      SELECT * FROM ledger WHERE tenant = ${t.tenant.id} AND grant_id IN (SELECT id FROM sub) ORDER BY id DESC LIMIT 200`,
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

// --- The autonomy dial: approvals + turning it down (autonomy.js) -------------------
// A value action requested at autonomy "ask" waits in `approvals`. Only the tenant's
// ROOT grant (depth 0 — the owner's credential) may approve or deny it: an agent's own
// `confirm: true` never counts at "ask". The approval is recorded on the ledger row
// the action settles, so the book says which agent acted and which human said yes.
app.get("/api/approvals", requireGrant(null), async (e) => {
  let t = e.get("auth");
  // Subtree-scoped like /api/ledger: a caller sees approvals for its own grant and
  // its descendants; the root sees the whole tenant.
  // A pending deploy's intent carries its env values; readers get the names only.
  return e.json({
    approvals: (
      await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
      SELECT * FROM approvals WHERE tenant = ${t.tenant.id} AND grant_id IN (SELECT id FROM sub) ORDER BY created_at DESC LIMIT 100`
    ).map(withRedactedIntent),
  });
});
app.post("/api/approvals/:id", requireGrant(null), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e),
    id = e.req.param("id"),
    verdict = a?.decision;
  if (Number(t.row.depth) !== 0) throw new HttpError(403, "owner_approval_required", { hint: "approve with the tenant's root grant" });
  if (verdict !== "approve" && verdict !== "deny") throw new HttpError(400, "decision_must_be_approve_or_deny");
  // Claim the approval atomically: only one caller ever moves it out of pending.
  let ap = (
    await sql`UPDATE approvals SET status = ${verdict === "approve" ? "approved" : "denied"}, approver = ${t.row.id}, decided_at = now()
    WHERE id = ${id} AND tenant = ${t.tenant.id} AND status = 'pending' RETURNING *`
  )[0];
  if (!ap) throw new HttpError(404, "approval_not_pending");
  let g = await getGrant(ap.grant_id);
  if (verdict === "deny") {
    if (g) await recordAutonomyRow(g, "autonomy-denied", ap.id, `${ap.action} denied by the owner`, { autonomy: ap.autonomy, decision: "denied", approver: t.row.id });
    await recordEvent("autonomy.denied", { approval: ap.id, action: ap.action }, t.tenant.id, t.row.sub);
    return e.json({ id: ap.id, status: "denied" });
  }
  // Approved: run the exact intent the agent asked for, under the agent's own grant —
  // which must still be live, and so must every grant above it (grants.js, endedAbove: this
  // path does not come through verifyGrant, and a deploy is created before it is charged).
  // The kill switch stops approved actions too.
  let fail = async (reason) => {
    await sql`UPDATE approvals SET status = 'failed', result = ${{ reason }}::jsonb WHERE id = ${ap.id}`;
    throw new HttpError(409, reason);
  };
  if (await isKillSwitchOn()) await fail("kill_switch_on");
  if (!g || g.status !== "active" || Number(g.exp) <= nowSec() || (await endedAbove(sql, g.id))) await fail("requesting_grant_not_active");
  let tenant = await getTenant(g.tenant),
    intent = parseJson(ap.intent),
    result;
  try {
    if (ap.action === "deploy") result = await deployWorker({ row: g, tenant }, intent, !0, ap.requested_by, { approvedBy: t.row.id });
    else if (ap.action === "escrow.open") {
      let r = await openEscrow(g, intent, ap.requested_by);
      await recordAutonomyRow(g, "autonomy-approved", ap.id, "escrow open approved by the owner", { autonomy: ap.autonomy, decision: "approved", approver: t.row.id });
      result = { escrow: serializeEscrow(r.row), token: r.token };
    } else await fail("unknown_action");
  } catch (err) {
    await sql`UPDATE approvals SET status = 'failed', result = ${{ reason: String(err?.message || err).slice(0, 200) }}::jsonb WHERE id = ${ap.id} AND status = 'approved'`;
    throw err;
  }
  // A deploy can be approved yet not run (e.g. Railway unarmed): say so, never "executed".
  let status = ap.action === "deploy" && !result?.executed ? "approved_not_run" : "executed";
  await sql`UPDATE approvals SET status = ${status}, result = ${{ id: result?.id ?? result?.escrow?.id ?? null, reason: result?.reason ?? null }}::jsonb WHERE id = ${ap.id}`;
  await recordEvent("autonomy.approved", { approval: ap.id, action: ap.action, status }, t.tenant.id, t.row.sub);
  return e.json({ id: ap.id, status, result });
});
// Turn a grant's dial DOWN (cascades to its subtree). Raising is refused: it takes a
// new grant from the issuer. The caller must be the grant itself or an ancestor.
app.post("/api/grants/:id/autonomy", requireGrant(null), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  return e.json(await lowerGrantAutonomy(t.row, e.req.param("id"), a?.level));
});

// --- Agent-hosts (docs/specs/agent-host.md, src/hostpolicy.js) -----------------------
// The OWNER mints a host: a grant (root -> host) an agent runs under and hires sub-agents
// from. Defaults: dial `ask`, 10 live sub-agents, 2 levels below the host, pro tier and up.
// Every hire is a child grant of the host — capped by its budget, caps, depth, dial and
// ceilings, and named agent:<host-id>/<role>. Revoking the host stops all of them.
app.post("/api/hosts", requireGrant("grant.issue"), async (e) => {
  let t = e.get("auth"),
    a = await readJsonBody(e);
  if (Number(t.row.depth) !== 0) throw new HttpError(403, "owner_required", { hint: "create hosts with the tenant's root grant" });
  if (!HOST_TIERS.includes(t.tenant.tier)) throw new HttpError(403, "host_tier_too_low", { tier: t.tenant.tier, allowed: HOST_TIERS });
  let name = hostName(a?.name);
  if (!name) throw new HttpError(400, "bad_host_name", { hint: "2-32 chars: a-z, 0-9, -" });
  let limits = hostLimits(a ?? {});
  if (!limits) throw new HttpError(400, "bad_host_limits");
  let rootCaps = parseJson(t.row.caps),
    caps = Array.isArray(a?.caps) ? a.caps : HOST_DEFAULT_CAPS.filter((c) => rootCaps.includes(c)),
    r = await issueChildGrant(
      t.row,
      {
        sub: `host:${name}`,
        caps,
        budget: a?.budget ?? HOST_DEFAULT_BUDGET,
        ttlSec: a?.ttlSec ?? 86400,
        scope: a?.scope,
        constraints: { ...(a?.constraints ?? {}), autonomy: a?.autonomy ?? HOST_DEFAULTS.autonomy },
      },
      t.row.sub,
      { host: limits },
    );
  await recordEvent("host.created", { id: r.row.id, name, limits }, t.tenant.id, t.row.sub);
  return e.json(
    {
      host: {
        id: r.row.id,
        name,
        sub: r.row.sub,
        autonomy: AUTONOMY_LEVELS[autonomyOf(parseJson(r.row.constraints))],
        limits,
        caps: parseJson(r.row.caps),
        budget: parseJson(r.row.budget),
        exp: Number(r.row.exp),
      },
      token: r.token,
      // To give the host a machine: POST /api/deploys with this template and the host
      // token as COS_GRANT_TOKEN (never the root token).
      machine: { template: "agent-host", env: { COS_GRANT_TOKEN: "<the host token above>" } },
    },
    201,
  );
});
// The hiring tree: the host and everything below it, with each grant's dial and books.
// Readable by the host itself or anything above it (e.g. the owner's root).
app.get("/api/hosts/:id", requireGrant(null), async (e) => {
  let t = e.get("auth"),
    id = e.req.param("id"),
    host = await getGrant(id);
  if (!host || host.tenant !== t.tenant.id || parseJson(host.constraints)?.host == null) throw new HttpError(404, "host_not_found");
  let reach =
    await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${t.row.id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
    SELECT 1 FROM sub WHERE id = ${id} LIMIT 1`;
  if (!reach.length) throw new HttpError(403, "not_in_your_subtree");
  let rows =
    await sql`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${id} UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id)
    SELECT * FROM sub ORDER BY depth, iat`;
  let now = nowSec(),
    view = (g) => ({
      id: g.id,
      parent: g.parent,
      sub: g.sub,
      depth: Number(g.depth),
      status: g.status === "active" && Number(g.exp) <= now ? "expired" : g.status,
      autonomy: AUTONOMY_LEVELS[autonomyOf(parseJson(g.constraints))],
      budget: parseJson(g.budget),
      settled: parseJson(g.settled),
      remaining: remainingBudget(g),
    }),
    pending =
      await sql`WITH RECURSIVE sub AS (SELECT id FROM grants WHERE id = ${id} UNION ALL SELECT g.id FROM grants g JOIN sub ON g.parent = sub.id)
      SELECT id, grant_id, action, created_at FROM approvals WHERE tenant = ${t.tenant.id} AND status = 'pending'
      AND grant_id IN (SELECT id FROM sub)`;
  return e.json({
    host: { ...view(rows[0]), limits: parseJson(rows[0].constraints).host },
    hires: rows.slice(1).map(view),
    live: rows.slice(1).filter((g) => g.status === "active" && Number(g.exp) > now).length,
    pendingApprovals: pending,
  });
});
