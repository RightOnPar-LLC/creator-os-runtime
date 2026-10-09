// COG planner (deterministic, optionally LLM-assisted) and executor.
import { randomBytes } from "crypto";
import { env } from "./config.js";
import { HttpError, parseJson } from "./util.js";
import { getGrant, recordEvent, sql } from "./db.js";
import { gatehouseEvaluate, memoryPartitions, normalizeOverlay, normalizeUsage, remainingBudget, tenantWorkerPrefix, TIERS } from "./policy.js";
import { issueChildGrant, revokeGrantTree } from "./grants.js";
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
// Evidence comes ONLY from memory the caller's own key may read: the key needs memory.read,
// and the search stays under the key's own memory sections. It used to search the whole
// tenant for anyone allowed to plan, so a guest (all guests share one tenant), or a key
// with an empty memory scope, could read other memory through the planner.
async function gatherPlanEvidence(e, t, a, row) {
  let caps = parseJson(row?.caps),
    parts = Array.isArray(caps) && caps.includes("memory.read") ? memoryPartitions(parseJson(row.scope) || {}).slice(0, 5) : [],
    n = [];
  for (let p of parts) {
    if (n.length >= 5) break;
    n.push(...(await searchMemories(e, a ? `${a} ${t}` : t, p, 5 - n.length)));
  }
  let r = a
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
  // Rewired off Anthropic onto the Z-13's own Ollama instance (work order 14:
  // "cog_plan and cog_execute need to hit Ollama, not the Anthropic API").
  // OLLAMA_URL is the Tailscale address of the Z-13's Ollama server (confirmed
  // listening on :11435, not Ollama's usual default :11434, with gpt-oss:120b
  // already pulled). No Anthropic key, no Anthropic network call, anywhere in
  // this function.
  if (!env.OLLAMA_URL) return null;
  try {
    let s = (
      (
        await (
          await fetch(`${env.OLLAMA_URL.replace(/\/$/, "")}/api/chat`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: env.COG_MODEL || "gpt-oss:120b",
              stream: false,
              messages: [
                {
                  role: "system",
                  content: `You are the COG planner. Choose exactly one template from: ${Object.keys(TEMPLATES).join(", ")}. Reply ONLY with JSON {"template": string, "env": object, "why": string}. Never invent secrets.`,
                },
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
      )?.message?.content || ""
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
      e.row,
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
export function lspTimeoutMs() {
  let e = Number(env.LSP_MCP_TIMEOUT_MS);
  return e > 0 ? Math.min(Math.floor(e), 240000) : 120000;
}
// A grant token only ever travels to lsp-mcp over TLS or the private network.
function lspMcpUrl() {
  let e = (env.LSP_MCP_URL || "").replace(/\/$/, "");
  if (!e) throw new HttpError(503, "diagnostics_unavailable", { needs: "LSP_MCP_URL" });
  let t;
  try {
    t = new URL(e);
  } catch {
    throw new HttpError(503, "diagnostics_unavailable", { lsp: "bad_url" });
  }
  let a = t.hostname;
  if (t.protocol !== "https:" && !(a === "127.0.0.1" || a === "localhost" || a.endsWith(".railway.internal")))
    throw new HttpError(503, "diagnostics_unavailable", { lsp: "insecure_url" });
  return e;
}
export async function diagnoseProposalFiles(e, t) {
  let a = lspMcpUrl();
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
      signal: AbortSignal.timeout(lspTimeoutMs()),
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
  // Whatever the caller attached as `diagnostics` is dropped on entry: the only
  // diagnostics this function ever sees are the ones it fetches itself.
  let { diagnostics: _dropped, ...proposal } = t && typeof t === "object" ? t : {};
  t = proposal;
  let n;
  if (Array.isArray(t.files) && t.files.length) {
    let d,
      remBefore = remainingBudget(e.row),
      hop = null;
    try {
      let f = normalizeOverlay(t.files);
      // Least privilege for the hop: present lsp-mcp an ephemeral child grant
      // (lsp.diagnose only, one call, 5 minutes) when the caller can mint one;
      // otherwise the caller's own token. Revoked right after, whatever happens.
      if (parseJson(e.row.caps).includes("grant.issue") && parseJson(e.row.caps).includes("lsp.diagnose"))
        try {
          hop = await issueChildGrant(
            e.row,
            {
              sub: `${e.row.sub}:lsp`.slice(0, 80),
              caps: ["lsp.diagnose"],
              ttlSec: 300,
              budget: { usd_cents: 0, calls: 1, deploys: 0 },
              scope: { memory: { partitions: [] } },
            },
            e.row.sub,
          );
        } catch {
          hop = null;
        }
      try {
        d = await diagnoseProposalFiles(f, hop ? hop.token : e.token);
      } finally {
        if (hop) await revokeGrantTree(hop.row.id, "lsp hop done", e.row.sub).catch(() => {});
      }
      t = { ...t, files: f, diagnostics: d };
    } catch (f) {
      let g = f instanceof HttpError ? f : new HttpError(500, "diagnostics_unavailable"),
        h = g.detail?.lsp || g.detail?.needs || g.detail?.path || (g.detail?.max !== void 0 ? `max=${g.detail.max}` : g.code);
      throw await denyCog(e, [`${g.code}:${String(h).slice(0, 200)}`]);
    }
    if (d.summary?.warnings)
      await recordEvent(
        "cog.diagnostics.warnings",
        {
          filesSha256: d.filesSha256,
          summary: d.summary,
          warnings: d.files.flatMap((f) =>
            (Array.isArray(f?.diagnostics) ? f.diagnostics : [])
              .filter((g) => g && typeof g === "object" && g.severity === "warning")
              .slice(0, 20)
              .map((g) => `${f.path}:${(+g.line | 0) + 1}:${(+g.col | 0) + 1}:${String(g.message ?? "").split("\n")[0].slice(0, 160)}`),
          ),
        },
        e.tenant.id,
        e.row.sub,
      );
    // The hop cost the caller `calls` while we waited. A plan whose grants fitted
    // the pre-charge remaining is nudged down by exactly that delta, on that one
    // dimension only; every other shortfall stays a refusal (attenuation 402/403).
    let fresh = await getGrant(e.row.id),
      remAfter = fresh ? remainingBudget(fresh) : null;
    if (remAfter && Array.isArray(t.grants))
      t.grants = t.grants.map((g) => {
        let b = normalizeUsage(g?.budget);
        return b.calls > remAfter.calls && b.calls <= remBefore.calls ? { ...g, budget: { ...b, calls: Math.max(0, remAfter.calls) } } : g;
      });
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
    let o = await issueChildGrant(
      e.row,
      i,
      e.row.sub,
      t.diagnostics && (i.caps || []).includes("code.write") ? { codeWrite: { filesSha256: t.diagnostics.filesSha256 } } : {},
    );
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
        filesSha256: t.diagnostics?.filesSha256 ?? null,
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
