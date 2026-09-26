// COG planner (deterministic, optionally LLM-assisted) and executor.
import { randomBytes } from "crypto";
import { env } from "./config.js";
import { HttpError, parseJson } from "./util.js";
import { recordEvent, sql } from "./db.js";
import { gatehouseEvaluate, normalizeOverlay, remainingBudget, tenantWorkerPrefix, TIERS } from "./policy.js";
import { issueChildGrant } from "./grants.js";
import { searchMemories, writeMemory } from "./memory.js";
import { deployWorker, TEMPLATES } from "./railway.js";

function guessTemplateFromIntent(e) {
  let t = e.toLowerCase();
  if (/\bprobe|smoke|hello|whoami\b/.test(t)) return "probe";
  if (/\btip|alert|donat/.test(t)) return "tip-alert-bot";
  if (/\bpaywall|unlock|checkout|ppv\b/.test(t)) return "paywall-link";
  if (/\bclip|post|schedul/.test(t)) return "clip-poster";
  if (/\bdm\b|message|respond|inbox/.test(t)) return "dm-autoresponder";
  if (/\brelay|webhook|bridge\b/.test(t)) return "webhook-relay";
  return null;
}
async function gatherPlanEvidence(e, t, a) {
  let n = await searchMemories(e, a ? `${a} ${t}` : t, "", 5),
    r = a
      ? await sql`SELECT 1 FROM events WHERE tenant = ${e} AND type = 'worker.failed' AND data->>'template' = ${a} LIMIT 3`
      : [];
  return {
    evidence: n.map((s) => ({
      id: s.id,
      partition: s.partition,
      key: s.key,
      snippet: s.content.slice(0, 200),
    })),
    priorFailures: r.length,
  };
}
function buildDeterministicPlan(
  e,
  t,
  a,
  n = {},
  r = {
    evidence: [],
    priorFailures: 0,
  },
) {
  let s = n.template && TEMPLATES[n.template] ? n.template : guessTemplateFromIntent(a);
  if (!s)
    return {
      needsClarification: !0,
      options: Object.keys(TEMPLATES),
      question:
        "Which worker? (probe, tip-alert-bot, paywall-link, clip-poster, dm-autoresponder, webhook-relay)",
      evidence: r.evidence,
    };
  let i = TEMPLATES[s],
    o = TIERS[e.tier],
    l = parseJson(t.scope),
    c = l.workers?.namePrefix || tenantWorkerPrefix(e.id),
    E = `${c}${s}-${randomBytes(2).toString("hex")}`.slice(0, 48),
    T = Math.min(3600, o.maxTtlSec),
    R = {
      usd_cents: Math.min(i.estCents * 2, remainingBudget(t).usd_cents),
      calls: Math.min(20, remainingBudget(t).calls),
      deploys: Math.min(1, remainingBudget(t).deploys),
    };
  return {
    intent: a,
    template: s,
    grants: [
      {
        key: "deployer",
        sub: `agent:deployer:${s}`,
        caps: ["deploy.worker", "worker.status", "memory.read", "memory.write"],
        ttlSec: T,
        budget: R,
        scope: {
          railway: {
            projects: l.railway?.projects || [],
            environments: l.railway?.environments || ["production"],
          },
          workers: {
            namePrefix: c,
          },
          memory: {
            partitions: [`worker:${E}`, `agent:deployer:${s}`],
          },
        },
        constraints: {
          maxWorkers: 1,
          maxReplicas: 1,
          allowDelete: !1,
          requireDryRun: !0,
        },
      },
    ],
    deploys: [
      {
        grant: "deployer",
        name: E,
        template: s,
        env: n.env || {},
        replicas: 1,
        target: {
          project: l.railway?.projects?.[0] || null,
          environment: l.railway?.environments?.[0] || "production",
        },
      },
    ],
    estimate: {
      usd_cents: i.estCents,
      deploys: 1,
      missingEnv: i.needs.filter((S) => !(n.env || {})[S]),
    },
    rationale: `Template "${s}" (${i.desc}). One sub-agent grant, one worker, dry-run first.${r.priorFailures ? ` ${r.priorFailures} prior failure(s) on this template \u2014 check evidence.` : ""}`,
    evidence: r.evidence,
    warnings: r.priorFailures ? [`prior_failures:${s}:${r.priorFailures}`] : [],
    planner: "deterministic",
  };
}
async function planWithLlm(e, t, a, n, r) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    let s = (
      (
        await (
          await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: env.COG_MODEL || "claude-sonnet-4-5",
              max_tokens: 300,
              system: `You are the COG planner. Choose exactly one template from: ${Object.keys(TEMPLATES).join(", ")}. Reply ONLY with JSON {"template": string, "env": object, "why": string}. Never invent secrets.`,
              messages: [
                {
                  role: "user",
                  content: `Creator intent: ${a}
Hints: ${JSON.stringify(n)}
Evidence (prior memory): ${JSON.stringify(r.evidence.map((l) => l.snippet))}`,
                },
              ],
            }),
          })
        ).json()
      )?.content?.[0]?.text || ""
    ).match(/\{[\s\S]*\}/);
    if (!s) return null;
    let i = JSON.parse(s[0]);
    if (!TEMPLATES[i.template]) return null;
    let o = buildDeterministicPlan(
      e,
      t,
      a,
      {
        ...n,
        template: i.template,
        env: {
          ...(n.env || {}),
          ...(i.env || {}),
        },
      },
      r,
    );
    return ((o.planner = "llm+deterministic"), (o.rationale = `${i.why || ""} \u2014 ${o.rationale}`), o);
  } catch {
    return null;
  }
}
export async function cogPlan(e, t, a) {
  let n = await gatherPlanEvidence(
      e.tenant.id,
      t,
      a.template && TEMPLATES[a.template] ? a.template : guessTemplateFromIntent(t),
    ),
    r = (await planWithLlm(e.tenant, e.row, t, a, n)) || buildDeterministicPlan(e.tenant, e.row, t, a, n);
  return (
    await recordEvent(
      "cog.planned",
      {
        template: r.template || null,
        planner: r.planner || "n/a",
      },
      e.tenant.id,
      e.row.sub,
    ),
    r
  );
}
// 0.3.2: ask lsp-mcp for diagnostics over the proposal's files, presenting the
// CALLER's grant (lsp-mcp introspects it here; the caller must hold lsp.diagnose).
// Nothing the caller attached as `diagnostics` is trusted: this is the only source.
export async function diagnoseProposalFiles(e, t) {
  let a = (env.LSP_MCP_URL || "").replace(/\/$/, "");
  if (!a) throw new HttpError(503, "diagnostics_unavailable", { needs: "LSP_MCP_URL" });
  let n, r;
  try {
    ((n = await fetch(`${a}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "diagnose",
          arguments: {
            files: e,
          },
        },
      }),
      signal: AbortSignal.timeout(Number(env.LSP_MCP_TIMEOUT_MS || 150000)),
    })),
      (r = await n.json()));
  } catch {
    throw new HttpError(503, "diagnostics_unavailable", { lsp: "unreachable" });
  }
  if (!n.ok || r?.error)
    throw new HttpError(n.status === 402 ? 402 : 403, "diagnostics_refused", {
      lsp: r?.error?.message || `http_${n.status}`,
      detail: r?.error?.data ?? null,
    });
  let s = r?.result?.structuredContent;
  if (!s || typeof s !== "object" || !Array.isArray(s.files)) throw new HttpError(502, "diagnostics_unavailable", { lsp: "bad_result" });
  return s;
}
async function denyCog(e, t) {
  await recordEvent(
    "cog.denied",
    {
      reasons: t,
    },
    e.tenant.id,
    e.row.sub,
  );
  return new HttpError(403, "gatehouse_denied", t);
}
export async function cogExecute(e, t, a) {
  let n;
  if (Array.isArray(t?.files) && t.files.length) {
    let d;
    try {
      let f = normalizeOverlay(t.files);
      d = await diagnoseProposalFiles(f, e.token);
      t = { ...t, files: f, diagnostics: d };
    } catch (f) {
      let g = f instanceof HttpError ? f : new HttpError(500, "diagnostics_unavailable");
      throw await denyCog(e, [`${g.code}:${g.detail?.lsp || g.detail?.needs || g.detail?.path || g.code}`]);
    }
    if (d.summary?.warnings)
      await recordEvent(
        "cog.diagnostics.warnings",
        {
          filesSha256: d.filesSha256,
          summary: d.summary,
          warnings: d.files.flatMap((f) => (f.diagnostics || []).filter((g) => g.severity === "warning").slice(0, 20).map((g) => `${f.path}:${g.line + 1}:${g.col + 1}:${String(g.message).split("\n")[0].slice(0, 160)}`)),
        },
        e.tenant.id,
        e.row.sub,
      );
  }
  n = gatehouseEvaluate(e.tenant, e.row, t);
  if (!n.ok)
    throw (
      await recordEvent(
        "cog.denied",
        {
          reasons: n.reasons,
        },
        e.tenant.id,
        e.row.sub,
      ),
      new HttpError(403, "gatehouse_denied", n.reasons)
    );
  let r = {};
  for (let i of t.grants) {
    if (!parseJson(e.row.caps).includes("grant.issue"))
      throw new HttpError(403, "missing_cap", {
        need: "grant.issue",
      });
    let o = await issueChildGrant(e.row, i, e.row.sub);
    r[i.key || o.row.id] = {
      id: o.row.id,
      token: o.token,
      row: o.row,
    };
  }
  let s = [];
  for (let i of t.deploys) {
    let o = r[i.grant];
    if (!o) throw new HttpError(400, "deploy_references_unknown_grant");
    let l = i.target || {},
      c = await deployWorker(
        {
          row: o.row,
          tenant: e.tenant,
        },
        {
          name: i.name,
          template: i.template,
          env: i.env,
          replicas: i.replicas,
          target: l,
        },
        !!a,
        o.row.sub,
      );
    (s.push(c),
      await writeMemory(
        e.tenant.id,
        "agent:cog",
        `deploy:${i.name}`,
        `${i.template} \u2192 ${c.status}${c.reason ? ` (${c.reason})` : ""} via ${o.row.sub}; image ${c.plan.image}; deploy ${c.id}`,
        ["cog", i.template, c.status],
        e.row.sub,
      ));
  }
  return (
    await recordEvent(
      "cog.executed",
      {
        grants: Object.values(r).map((i) => i.id),
        deploys: s.map((i) => i.id),
        confirm: !!a,
      },
      e.tenant.id,
      e.row.sub,
    ),
    {
      grants: Object.fromEntries(
        Object.entries(r).map(([i, o]) => [
          i,
          {
            id: o.id,
            token: o.token,
            sub: o.row.sub,
            exp: Number(o.row.exp),
          },
        ]),
      ),
      deploys: s,
      diagnostics: t.diagnostics
        ? {
            filesSha256: t.diagnostics.filesSha256,
            backend: t.diagnostics.backend,
            summary: t.diagnostics.summary,
            warnings: t.diagnostics.warnings || [],
          }
        : void 0,
    }
  );
}
