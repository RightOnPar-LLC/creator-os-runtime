// Worker templates and Railway deploy/status/restart/delete via GraphQL.
import { env, POLICY_VERSION } from "./config.js";
import { HttpError, newId, parseJson } from "./util.js";
import { recordEvent, sql } from "./db.js";
import { vaultDecrypt, vaultKey } from "./tokens.js";
import { remainingBudget, TIERS, usageWithin, workerNameCovers } from "./policy.js";
import { settleGrantUsage } from "./grants.js";

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
    image: "ghcr.io/think-zone/creator-worker:latest",
    kind: "tip-alert",
    desc: "Tip events \u2192 Discord / OBS alerts",
    env: {
      WORKER_KIND: "tip-alert",
    },
    needs: ["DISCORD_WEBHOOK_URL"],
    estCents: 60,
  },
  "paywall-link": {
    image: "ghcr.io/think-zone/creator-worker:latest",
    kind: "paywall",
    desc: "Checkout link \u2192 content unlock, with receipts",
    env: {
      WORKER_KIND: "paywall",
    },
    needs: ["STRIPE_SECRET_KEY"],
    estCents: 60,
  },
  "clip-poster": {
    image: "ghcr.io/think-zone/creator-worker:latest",
    kind: "clips",
    desc: "Schedules and posts clips across platforms",
    env: {
      WORKER_KIND: "clips",
    },
    needs: ["POSTIZ_API_KEY"],
    estCents: 80,
  },
  "dm-autoresponder": {
    image: "ghcr.io/think-zone/creator-worker:latest",
    kind: "dm",
    desc: "Answers DMs from a persona, escalates to you",
    env: {
      WORKER_KIND: "dm",
    },
    needs: ["ANTHROPIC_API_KEY"],
    estCents: 90,
  },
  "webhook-relay": {
    image: "ghcr.io/think-zone/creator-worker:latest",
    kind: "relay",
    desc: "Relays platform webhooks to the Brain bus",
    env: {
      WORKER_KIND: "relay",
    },
    needs: [],
    estCents: 30,
  },
};
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
export async function deployWorker(e, t, a, n) {
  let r = TEMPLATES[t.template];
  if (!r) throw new HttpError(400, "unknown_template");
  let s = parseJson(e.row.constraints),
    i = parseJson(e.row.scope),
    o = t.target?.project || i.railway?.projects?.[0] || null,
    l = t.target?.environment || i.railway?.environments?.[0] || "production",
    c = String(t.name || "").toLowerCase();
  if (!/^[a-z0-9-]{3,48}$/.test(c)) throw new HttpError(400, "bad_worker_name");
  if (!workerNameCovers(i.workers?.namePrefix || "", c))
    throw new HttpError(403, "out_of_scope", {
      workerName: c,
    });
  if (o && !(i.railway?.projects || []).includes(o))
    throw new HttpError(403, "out_of_scope", {
      project: o,
    });
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
      image: r.image,
      replicas: E,
      env: Object.keys(S),
      missingEnv: B,
      estCents: r.estCents,
      policy: POLICY_VERSION,
    },
    C = newId("dp"),
    pe =
      await sql`SELECT 1 FROM deploys WHERE tenant = ${e.tenant.id} AND name = ${c} AND executed = true LIMIT 1`,
    H = s.requireDryRun && pe.length === 0 && !a,
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
  else
    (await settleGrantUsage(e.row.id, R, C, `deploy ${c}`),
      (Le =
        (
          await railwayGraphql(
            P.token,
            "mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }",
            {
              input: {
                projectId: o,
                name: c,
                source: {
                  image: r.image,
                },
                variables: S,
              },
            },
          )
        )?.serviceCreate?.id || null),
      (ee = "deploying"),
      (te = !0),
      (ke = {
        serviceId: Le,
        via: P.source,
      }),
      await sql`UPDATE tenants SET deploys_period = deploys_period + 1, updated_at = now() WHERE id = ${e.tenant.id}`);
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
