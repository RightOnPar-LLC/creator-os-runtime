// Worker templates and Railway deploy/status/restart/delete via GraphQL.
import { env, POLICY_VERSION } from "./config.js";
import { HttpError, newId, parseJson } from "./util.js";
import { recordEvent, sql } from "./db.js";
import { vaultDecrypt, vaultKey } from "./tokens.js";
import { remainingBudget, TIERS, usageWithin } from "./policy.js";
import { recordAutonomyRow, settleGrantUsage } from "./grants.js";
import { autonomyOf, decide } from "./autonomy.js";

// Workers that run the creator-worker codebase are built by Railway straight from
// the repo (Dockerfile at its root). No registry image, no pull credentials:
// the previous ghcr.io/think-zone/creator-worker image never existed, so every
// template that named it could not start (2026-09-26 fix).
var WORKER_REPO = env.CREATOR_WORKER_REPO || "RightOnPar-LLC/creator-worker";
var WORKER_BRANCH = env.CREATOR_WORKER_BRANCH || "main";
// Owners whose repos the repo-app template may deploy. Comma-separated, case-insensitive.
var REPO_OWNERS = String(env.DEPLOY_REPO_OWNERS || "RightOnPar-LLC,think-zone")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
// AUTONOMOUS_DEPLOYS=1 skips the first-run dry-run gate for every grant. Budget,
// scope, name prefix, maxWorkers, tier limits and the kill switch still apply.
// Unset it to put the dry-run gate back without a code change.
export var autonomousDeploys = () => env.AUTONOMOUS_DEPLOYS === "1";

export var TEMPLATES = {
  probe: {
    image: "traefik/whoami:latest",
    kind: "probe",
    desc: "Tiny HTTP responder that proves the deploy path",
    env: {},
    needs: [],
    estCents: 25,
  },
  "tip-alert-bot": {
    repo: WORKER_REPO,
    kind: "tip-alert",
    desc: "Tip events → Discord / OBS alerts",
    env: {
      WORKER_KIND: "tip-alert",
    },
    needs: ["DISCORD_WEBHOOK_URL"],
    estCents: 60,
  },
  "paywall-link": {
    repo: WORKER_REPO,
    kind: "paywall",
    desc: "Checkout link → content unlock, with receipts",
    env: {
      WORKER_KIND: "paywall",
    },
    needs: ["STRIPE_SECRET_KEY"],
    estCents: 60,
  },
  "clip-poster": {
    repo: WORKER_REPO,
    kind: "clips",
    desc: "Schedules and posts clips across platforms",
    env: {
      WORKER_KIND: "clips",
    },
    needs: ["POSTIZ_API_KEY"],
    estCents: 80,
  },
  "dm-autoresponder": {
    repo: WORKER_REPO,
    kind: "dm",
    desc: "Answers DMs from a persona, escalates to you",
    env: {
      WORKER_KIND: "dm",
    },
    needs: ["ANTHROPIC_API_KEY"],
    estCents: 90,
  },
  "webhook-relay": {
    repo: WORKER_REPO,
    kind: "relay",
    desc: "Relays platform webhooks to the Brain bus",
    env: {
      WORKER_KIND: "relay",
    },
    needs: [],
    estCents: 30,
  },
  // Deploy any repo from an allowed owner. Intent carries { repo: "owner/name", branch? }.
  "repo-app": {
    repo: null,
    kind: "repo-app",
    desc: "Builds and runs any repo from your org (Dockerfile or Nixpacks)",
    env: {},
    needs: [],
    estCents: 100,
  },
  // Spec in, running app out: writes code with Claude into a new org repo, then
  // deploys it through this runtime with the repo-app template.
  builder: {
    repo: WORKER_REPO,
    kind: "builder",
    desc: "Turns a written spec into a new repo and deploys it (repo-app)",
    env: {
      WORKER_KIND: "builder",
    },
    needs: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "COS_GRANT_TOKEN", "BUILDER_TOKEN"],
    estCents: 120,
  },
  // The agent-host (docs/specs/agent-host.md): a machine an agent runs in and hires
  // sub-agents from. COS_GRANT_TOKEN is the HOST grant minted by POST /api/hosts —
  // never the owner's root — so everything it hires is a child of the host, capped
  // by the host's budget, ceilings and dial.
  "agent-host": {
    repo: WORKER_REPO,
    kind: "agent-host",
    desc: "A machine where one agent hires sub-agents under its own grant and dial",
    env: {
      WORKER_KIND: "agent-host",
    },
    needs: ["ANTHROPIC_API_KEY", "COS_GRANT_TOKEN"],
    estCents: 120,
  },
};
var REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
function resolveSource(e, t) {
  if (e.image)
    return {
      source: {
        image: e.image,
      },
      label: e.image,
    };
  let a = e.repo || t.repo,
    n = e.repo ? WORKER_BRANCH : t.branch || "main";
  if (!a || !REPO_RE.test(String(a))) throw new HttpError(400, "bad_repo", { repo: a || null });
  if (!REPO_OWNERS.includes(String(a).split("/")[0].toLowerCase()))
    throw new HttpError(403, "repo_owner_not_allowed", { repo: a, allowed: REPO_OWNERS });
  // creator-worker is the declared build source for the tip-alert/paywall/clips/dm/
  // relay/builder templates, but the repo is still empty (2026-09-26). Refuse a build
  // from it until it has code, so a deploy fails HERE with a clear reason instead of
  // obscurely inside a Railway build. Lift with CREATOR_WORKER_READY=1 once populated;
  // a repo-app deploy of some other populated repo is unaffected (source != WORKER_REPO).
  if (String(a) === WORKER_REPO && env.CREATOR_WORKER_READY !== "1")
    throw new HttpError(409, "creator_worker_repo_unpopulated", {
      repo: a,
      hint: "the creator-worker repo has no code yet; populate it and set CREATOR_WORKER_READY=1, or use repo-app with a repo that has a Dockerfile/Nixpacks build",
    });
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(String(n))) throw new HttpError(400, "bad_branch");
  return {
    source: {
      repo: String(a),
    },
    branch: String(n),
    label: `github:${a}@${n}`,
  };
}
var RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
async function railwayGraphql(e, t, a) {
  let n = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${e}`,
      },
      body: JSON.stringify({
        query: t,
        variables: a,
      }),
    }),
    r = await n.json().catch(() => ({}));
  if (!n.ok || r.errors)
    throw new HttpError(502, "railway_api_error", r.errors?.map((s) => s.message) || n.status);
  return r.data;
}
async function resolveRailwayToken(e) {
  let t = (await sql`SELECT * FROM vault WHERE tenant = ${e} AND provider = 'railway'`)[0];
  if (t && vaultKey())
    try {
      return {
        token: JSON.parse(vaultDecrypt(t)).access_token,
        source: "tenant-oauth",
      };
    } catch {}
  if (env.RAILWAY_API_TOKEN)
    return {
      token: env.RAILWAY_API_TOKEN,
      source: "house",
    };
  return null;
}
// `o.approvedBy` is set only when the tenant's root grant approved THIS deploy
// (routes/grants.js POST /api/approvals/:id) — never from the request body.
export async function deployWorker(e, t, a, n, opts = {}) {
  let r = TEMPLATES[t.template];
  if (!r) throw new HttpError(400, "unknown_template");
  let s = parseJson(e.row.constraints),
    i = parseJson(e.row.scope),
    o = t.target?.project || i.railway?.projects?.[0] || null,
    l = t.target?.environment || i.railway?.environments?.[0] || "production",
    c = String(t.name || "").toLowerCase();
  // probe-only for guests (any template-restricted grant): reject a template not on
  // the grant's allow-list BEFORE any plan-insert or settle, so a refused deploy is
  // neither charged nor planned — and before the project checks, so it holds even if
  // a project scope is ever opened. Absent list == wildcard (existing grants).
  if (Array.isArray(i.templates) && !i.templates.includes(t.template))
    throw new HttpError(403, "template_not_allowed", { template: t.template, allowed: i.templates });
  if (!/^[a-z0-9-]{3,48}$/.test(c)) throw new HttpError(400, "bad_worker_name");
  if (!c.startsWith(i.workers?.namePrefix || "\x00"))
    throw new HttpError(403, "out_of_scope", {
      workerName: c,
    });
  if (o && !(i.railway?.projects || []).includes(o))
    throw new HttpError(403, "out_of_scope", {
      project: o,
    });
  let src = resolveSource(r, t);
  let E = Math.min(Math.max(1, Math.floor(+t.replicas || 1)), s.maxReplicas);
  if (
    (
      await sql`SELECT count(*)::int AS n FROM deploys WHERE tenant = ${e.tenant.id} AND status NOT IN ('deleted','failed','dry_run')`
    )[0].n >= s.maxWorkers
  )
    throw new HttpError(403, "max_workers_reached", {
      maxWorkers: s.maxWorkers,
    });
  let T = TIERS[e.tenant.tier];
  if (e.tenant.deploys_period >= T.deploysPerPeriod) throw new HttpError(402, "tier_deploys_exhausted");
  let R = {
    usd_cents: r.estCents,
    calls: 1,
    deploys: 1,
  };
  if (!usageWithin(R, remainingBudget(e.row)))
    throw new HttpError(402, "budget_exhausted", {
      need: R,
      remaining: remainingBudget(e.row),
    });
  // The autonomy dial (autonomy.js), checked only after scope + budget pass so a
  // human is never asked to approve a deploy that could not run anyway.
  let dial = decide(autonomyOf(s), "deploy", { approvedBy: opts.approvedBy || null });
  if (dial.decision === "refuse") {
    await recordAutonomyRow(e.row, "autonomy-refused", c, `deploy ${c} refused at autonomy ${dial.levelName}`, {
      autonomy: dial.level,
      decision: "refuse",
    });
    await recordEvent("autonomy.refused", { action: "deploy", name: c, level: dial.levelName }, e.tenant.id, n);
    throw new HttpError(403, dial.reason, { autonomy: dial.levelName });
  }
  if (dial.decision === "ask") {
    let ap = newId("ap");
    await sql`INSERT INTO approvals (id, tenant, grant_id, action, intent, autonomy, requested_by)
      VALUES (${ap}, ${e.tenant.id}, ${e.row.id}, 'deploy', ${t}::jsonb, ${dial.level}, ${n})`;
    await recordAutonomyRow(e.row, "autonomy-ask", ap, `deploy ${c} awaits the owner's approval`, {
      autonomy: dial.level,
      decision: "ask",
    });
    await recordEvent("autonomy.ask", { action: "deploy", name: c, approval: ap, level: dial.levelName }, e.tenant.id, n);
    return {
      id: ap,
      executed: !1,
      status: "awaiting_approval",
      reason: dial.reason,
      approval: { id: ap, action: "deploy", name: c, approve: `POST /api/approvals/${ap}` },
    };
  }
  let S = {
      ...r.env,
      ...(t.env || {}),
      COS_TENANT: e.tenant.id,
      COS_WORKER: c,
      COS_GRANT: e.row.id,
    },
    B = r.needs.filter((ft) => !(ft in S)),
    $ = {
      action: "railway.serviceCreate",
      project: o,
      environment: l,
      name: c,
      source: src.label,
      replicas: E,
      env: Object.keys(S),
      missingEnv: B,
      estCents: r.estCents,
      autonomous: autonomousDeploys(),
      policy: POLICY_VERSION,
    },
    C = newId("dp"),
    pe =
      await sql`SELECT 1 FROM deploys WHERE tenant = ${e.tenant.id} AND name = ${c} AND executed = true LIMIT 1`,
    H = s.requireDryRun && pe.length === 0 && !a && !autonomousDeploys(),
    P = await resolveRailwayToken(e.tenant.id),
    ee = "dry_run",
    te = !1,
    ke = null,
    J = null,
    Le = null;
  if (H) J = "dry_run";
  else if (!P) J = "unarmed:RAILWAY_API_TOKEN";
  else if (!o) J = "no_target_project";
  else if (B.length) J = "missing_env:" + B.join(",");
  else {
    let input = {
      projectId: o,
      name: c,
      source: src.source,
      variables: S,
    };
    if (src.branch) input.branch = src.branch;
    // Create first, charge after: a Railway rejection no longer burns grant budget.
    Le =
      (
        await railwayGraphql(
          P.token,
          "mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }",
          {
            input,
          },
        )
      )?.serviceCreate?.id || null;
    await settleGrantUsage(e.row.id, R, C, `deploy ${c}`, "settle", {
      autonomy: dial.level,
      decision: opts.approvedBy ? "approved" : "act",
      approver: opts.approvedBy || null,
    });
    ee = "deploying";
    te = !0;
    ke = {
      serviceId: Le,
      via: P.source,
      source: src.label,
    };
    await sql`UPDATE tenants SET deploys_period = deploys_period + 1, updated_at = now() WHERE id = ${e.tenant.id}`;
  }
  return (
    await sql`INSERT INTO deploys (id, tenant, grant_id, name, template, intent, plan, status, executed, railway_service_id, target, result)
    VALUES (${C}, ${e.tenant.id}, ${e.row.id}, ${c}, ${t.template}, ${t}::jsonb, ${$}::jsonb, ${ee}, ${te}, ${Le},
            ${{
              project: o,
              environment: l,
            }}::jsonb, ${ke}::jsonb)`,
    await recordEvent(
      te ? "deploy.requested" : "deploy.planned",
      {
        id: C,
        name: c,
        template: t.template,
        reason: J,
        executed: te,
      },
      e.tenant.id,
      n,
    ),
    {
      id: C,
      executed: te,
      status: ee,
      reason: J,
      plan: $,
      result: ke,
    }
  );
}
export async function refreshDeployStatus(e, t) {
  let a = (await sql`SELECT * FROM deploys WHERE id = ${t} AND tenant = ${e.tenant.id}`)[0];
  if (!a) throw new HttpError(404, "deploy_not_found");
  let n = await resolveRailwayToken(e.tenant.id);
  if (a.railway_service_id && n)
    try {
      let r = parseJson(a.target),
        s = (
          await railwayGraphql(
            n.token,
            "query($i: DeploymentListInput!) { deployments(input: $i, first: 1) { edges { node { id status createdAt } } } }",
            {
              i: {
                projectId: r.project,
                serviceId: a.railway_service_id,
              },
            },
          )
        )?.deployments?.edges?.[0]?.node;
      if (s)
        (await sql`UPDATE deploys SET status = ${String(s.status).toLowerCase()}, railway_deployment_id = ${s.id}, updated_at = now() WHERE id = ${a.id}`,
          (a.status = String(s.status).toLowerCase()));
      await settleGrantUsage(
        e.row.id,
        {
          usd_cents: 0,
          calls: 1,
          deploys: 0,
        },
        a.id,
        "status",
      );
    } catch (r) {}
  return a;
}
async function hasActiveBreakglass(e) {
  return (await sql`SELECT 1 FROM breakglass WHERE tenant = ${e} AND until > now() LIMIT 1`).length > 0;
}
export async function deleteDeploy(e, t, a) {
  let n = (await sql`SELECT * FROM deploys WHERE id = ${t} AND tenant = ${e.tenant.id}`)[0];
  if (!n) throw new HttpError(404, "deploy_not_found");
  if (!parseJson(e.row.constraints).allowDelete) throw new HttpError(403, "delete_not_allowed_by_grant");
  if (
    (parseJson(n.target || {}).environment || "production") === "production" &&
    !(await hasActiveBreakglass(e.tenant.id))
  )
    throw new HttpError(403, "breakglass_required");
  let r = await resolveRailwayToken(e.tenant.id);
  if (n.railway_service_id) {
    if (!r)
      throw new HttpError(503, "unarmed", {
        needs: "RAILWAY_API_TOKEN",
      });
    (await railwayGraphql(r.token, "mutation($id: String!) { serviceDelete(id: $id) }", {
      id: n.railway_service_id,
    }),
      await settleGrantUsage(
        e.row.id,
        {
          usd_cents: 0,
          calls: 1,
          deploys: 0,
        },
        n.id,
        "delete",
      ));
  }
  return (
    await sql`UPDATE deploys SET status = 'deleted', updated_at = now() WHERE id = ${n.id}`,
    await recordEvent(
      "deploy.deleted",
      {
        id: n.id,
        name: n.name,
      },
      e.tenant.id,
      a,
    ),
    {
      id: n.id,
      status: "deleted",
    }
  );
}
export async function restartDeploy(e, t, a) {
  let n = (await sql`SELECT * FROM deploys WHERE id = ${t} AND tenant = ${e.tenant.id}`)[0];
  if (!n) throw new HttpError(404, "deploy_not_found");
  if (!n.railway_deployment_id) throw new HttpError(409, "no_live_deployment");
  let r = await resolveRailwayToken(e.tenant.id);
  if (!r)
    throw new HttpError(503, "unarmed", {
      needs: "RAILWAY_API_TOKEN",
    });
  return (
    await railwayGraphql(r.token, "mutation($id: String!) { deploymentRestart(id: $id) }", {
      id: n.railway_deployment_id,
    }),
    await settleGrantUsage(
      e.row.id,
      {
        usd_cents: 0,
        calls: 1,
        deploys: 0,
      },
      n.id,
      "restart",
    ),
    await recordEvent(
      "deploy.restarted",
      {
        id: n.id,
      },
      e.tenant.id,
      a,
    ),
    {
      id: n.id,
      restarted: !0,
    }
  );
}
