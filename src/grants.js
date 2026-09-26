// Grant lifecycle: mint root, issue child, revoke tree, settle usage, rate limit, verify.
import { randomBytes } from "crypto";
import { POLICY_VERSION, RATE_LIMIT_MAX_PER_MIN, SERVICE_NAME } from "./config.js";
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, getTenant, isKillSwitchOn, recordEvent, sql } from "./db.js";
import { parseGrantToken, signGrantToken } from "./tokens.js";
import {
  addUsage,
  attenuationViolations,
  CAPS,
  clampConstraints,
  memoryPartitions,
  normalizeUsage,
  remainingBudget,
  subtractUsage,
  tenantWorkerPrefix,
  TIERS,
  usageWithin,
  zeroUsage,
} from "./policy.js";

export async function mintRootGrant(e, t = "tenant:root") {
  let a = TIERS[e.tier],
    n = nowSec(),
    r = n + a.maxTtlSec * 4,
    s = newId("gr"),
    i = parseJson(e.allowed_targets || {}),
    o = {
      v: 1,
      id: s,
      tenant: e.id,
      parent: null,
      depth: 0,
      sub: t,
      iss: SERVICE_NAME,
      iat: n,
      exp: r,
      caps: [...CAPS],
      scope: {
        railway: {
          projects: i.railway?.projects || [],
          environments: i.railway?.environments || ["production"],
        },
        workers: {
          namePrefix: tenantWorkerPrefix(e.id),
        },
        memory: {
          partitions: [""],
        },
      },
      budget: {
        usd_cents: a.usdCents,
        calls: a.deploysPerPeriod * 50,
        deploys: a.deploysPerPeriod,
      },
      constraints: {
        maxWorkers: a.maxWorkers,
        maxReplicas: a.maxReplicas,
        allowDelete: !0,
        requireDryRun: !0,
      },
      nonce: randomBytes(8).toString("hex"),
    },
    l = JSON.stringify(o);
  return (
    await sql`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
    VALUES (${s}, ${e.id}, ${null}, 0, ${t}, ${o.caps}::jsonb, ${o.scope}::jsonb,
            ${o.budget}::jsonb, ${o.constraints}::jsonb, ${l}, ${POLICY_VERSION}, ${"admin"}, ${n}, ${r})`,
    await sql`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
    VALUES (${e.id}, ${s}, ${null}, 'root', ${o.budget.usd_cents}, ${o.budget.calls}, ${o.budget.deploys}, ${s}, 'root grant minted')`,
    await recordEvent(
      "grant.issued",
      {
        id: s,
        sub: t,
        depth: 0,
      },
      e.id,
      "admin",
    ),
    {
      row: await getGrant(s),
      token: signGrantToken(l),
    }
  );
}
export async function issueChildGrant(e, t, a) {
  let n = await getTenant(e.tenant);
  if (!n)
    throw Object.assign(Error("tenant_missing"), {
      status: 403,
    });
  let r = TIERS[n.tier],
    s = parseJson(e.scope),
    i = parseJson(e.constraints),
    o = Math.min(Math.max(60, Math.floor(t.ttlSec ?? 3600)), r.maxTtlSec),
    l = nowSec(),
    c = Math.min(l + o, Number(e.exp)),
    E = {
      railway: {
        projects: t.scope?.railway?.projects ?? s.railway?.projects ?? [],
        environments: t.scope?.railway?.environments ?? s.railway?.environments ?? [],
      },
      workers: {
        namePrefix: t.scope?.workers?.namePrefix ?? s.workers?.namePrefix ?? "",
      },
      memory: {
        partitions: t.scope?.memory?.partitions ?? memoryPartitions(s),
      },
    },
    T = normalizeUsage(t.budget ?? zeroUsage()),
    R = clampConstraints(t.constraints ?? {}, i),
    S = {
      caps: [...new Set(t.caps || [])],
      scope: E,
      budget: T,
      exp: c,
      constraints: R,
      depth: Number(e.depth) + 1,
    },
    B = attenuationViolations(e, S, n.tier);
  if (B.length)
    throw Object.assign(Error("attenuation_violation"), {
      status: 403,
      detail: B,
    });
  let $ = newId("gr"),
    C = {
      v: 1,
      id: $,
      tenant: n.id,
      parent: e.id,
      depth: S.depth,
      sub: String(t.sub || "agent:anon").slice(0, 80),
      iss: SERVICE_NAME,
      iat: l,
      exp: c,
      caps: S.caps,
      scope: E,
      budget: T,
      constraints: R,
      nonce: randomBytes(8).toString("hex"),
    },
    pe = JSON.stringify(C);
  return (
    await sql.begin(async (H) => {
      let P = (await H`SELECT * FROM grants WHERE id = ${e.id} FOR UPDATE`)[0];
      if (!P || P.status !== "active")
        throw Object.assign(Error("parent_not_active"), {
          status: 403,
        });
      if (!usageWithin(T, remainingBudget(P)))
        throw Object.assign(Error("budget_exceeds_parent_remaining"), {
          status: 402,
        });
      let ee = addUsage(normalizeUsage(parseJson(P.reserved)), T);
      (await H`UPDATE grants SET reserved = ${ee}::jsonb WHERE id = ${e.id}`,
        await H`INSERT INTO grants (id, tenant, parent, depth, sub, caps, scope, budget, constraints, payload, policy_version, issued_by, iat, exp)
      VALUES (${$}, ${n.id}, ${e.id}, ${S.depth}, ${C.sub}, ${S.caps}::jsonb, ${E}::jsonb,
              ${T}::jsonb, ${R}::jsonb, ${pe}, ${POLICY_VERSION}, ${a}, ${l}, ${c})`,
        await H`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${n.id}, ${$}, ${e.id}, 'reserve', ${T.usd_cents}, ${T.calls}, ${T.deploys}, ${$}, ${"reserved for " + C.sub})`);
    }),
    await recordEvent(
      "grant.issued",
      {
        id: $,
        parent: e.id,
        sub: C.sub,
        depth: S.depth,
        caps: S.caps,
      },
      n.id,
      a,
    ),
    {
      row: await getGrant($),
      token: signGrantToken(pe),
    }
  );
}
export async function revokeGrantTree(e, t, a) {
  let n = [];
  if (
    (await sql.begin(async (r) => {
      let s = await r`WITH RECURSIVE sub AS (SELECT * FROM grants WHERE id = ${e}
      UNION ALL SELECT g.* FROM grants g JOIN sub ON g.parent = sub.id) SELECT * FROM sub ORDER BY depth DESC FOR UPDATE`;
      for (let i of s) {
        if (i.status !== "active") continue;
        await r`UPDATE grants SET status = 'revoked', revoked_at = now(), revoke_reason = ${t} WHERE id = ${i.id}`;
        let o = subtractUsage(normalizeUsage(parseJson(i.budget)), normalizeUsage(parseJson(i.settled)));
        if (i.parent) {
          let l = (await r`SELECT reserved FROM grants WHERE id = ${i.parent} FOR UPDATE`)[0],
            c = subtractUsage(normalizeUsage(parseJson(l.reserved)), o);
          (await r`UPDATE grants SET reserved = ${{
            usd_cents: Math.max(0, c.usd_cents),
            calls: Math.max(0, c.calls),
            deploys: Math.max(0, c.deploys),
          }}::jsonb WHERE id = ${i.parent}`,
            await r`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
          VALUES (${i.tenant}, ${i.id}, ${i.parent}, 'release', ${o.usd_cents}, ${o.calls}, ${o.deploys}, ${i.id}, ${t})`);
        }
        n.push(i.id);
      }
    }),
    n.length)
  ) {
    let r = await getGrant(e);
    await recordEvent(
      "grant.revoked",
      {
        ids: n,
        reason: t,
      },
      r?.tenant || null,
      a,
    );
  }
  return n;
}
export async function settleGrantUsage(e, t, a, n) {
  await sql.begin(async (r) => {
    let s = (await r`SELECT * FROM grants WHERE id = ${e} FOR UPDATE`)[0];
    if (!s || s.status !== "active")
      throw Object.assign(Error("grant_not_active"), {
        status: 401,
      });
    if (!usageWithin(t, remainingBudget(s)))
      throw Object.assign(Error("budget_exhausted"), {
        status: 402,
      });
    (await r`UPDATE grants SET settled = ${addUsage(normalizeUsage(parseJson(s.settled)), t)}::jsonb WHERE id = ${e}`,
      await r`INSERT INTO ledger (tenant, grant_id, parent, kind, usd_cents, calls, deploys, ref, note)
      VALUES (${s.tenant}, ${e}, ${s.parent}, 'settle', ${t.usd_cents}, ${t.calls}, ${t.deploys}, ${a}, ${n})`);
  });
}
// Postgres-backed (fixed 60s window keyed by grant id), not a process-local
// Map: the runtime scales to multiple replicas and a replica-local bucket let
// each replica give the same grant its own fresh budget (2026-09-25 fix).
async function checkRateLimit(e) {
  let t = Math.floor(Date.now() / 60000) * 60000,
    a = (
      await sql`INSERT INTO rate_limits (grant_id, window_start, count) VALUES (${e}, ${t}, 1)
      ON CONFLICT (grant_id, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`
    )[0];
  if (Math.random() < 0.01) await sql`DELETE FROM rate_limits WHERE window_start < ${t - 300000}`;
  return a.count <= RATE_LIMIT_MAX_PER_MIN;
}
export async function verifyGrant(e, t, a, countRate = !0) {
  try {
    if (!e) throw new HttpError(401, "missing_grant");
    let n = parseGrantToken(e);
    if (!n) throw new HttpError(401, "bad_grant");
    let r = n.payload;
    if (Number(r.exp) <= nowSec())
      throw (
        await sql`UPDATE grants SET status='expired' WHERE id=${r.id} AND status='active'`,
        new HttpError(401, "grant_expired")
      );
    let s = await getGrant(r.id);
    if (!s || s.status !== "active") throw new HttpError(401, "grant_revoked");
    let i = await getTenant(s.tenant);
    if (!i || i.status !== "active") throw new HttpError(403, "tenant_suspended");
    if (await isKillSwitchOn()) throw new HttpError(503, "runtime_paused");
    let o = parseJson(s.caps);
    if (t && !o.includes(t))
      throw new HttpError(403, "missing_cap", {
        need: t,
      });
    if (a) {
      let l = parseJson(s.scope);
      if (a.project && !(l.railway?.projects || []).includes(a.project))
        throw new HttpError(403, "out_of_scope", {
          project: a.project,
        });
      if (a.environment && !(l.railway?.environments || []).includes(a.environment))
        throw new HttpError(403, "out_of_scope", {
          environment: a.environment,
        });
      if (a.workerName && !a.workerName.startsWith(l.workers?.namePrefix || "\x00"))
        throw new HttpError(403, "out_of_scope", {
          workerName: a.workerName,
        });
    }
    if (countRate && !(await checkRateLimit(s.id))) throw new HttpError(429, "rate_limited");
    return {
      row: s,
      tenant: i,
      payload: r,
    };
  } catch (n) {
    if (n instanceof HttpError) throw n;
    throw new HttpError(403, "verification_error");
  }
}
