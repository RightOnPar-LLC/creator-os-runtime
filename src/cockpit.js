// HTML page shell, status report (product probes), docs store and markdown renderer.
import { armedIntegrations, env, VERSION } from "./config.js";
import { nowSec } from "./util.js";
import { isKillSwitchOn, sql } from "./db.js";
import { sourceBytes, sourceSha256 } from "./http.js";
import { OAUTH_PROFILES } from "./oauth.js";

var PAGE_CSS =
  "body{margin:0;background:#050506;color:#f6f1e4;font:15px/1.5 Geist,system-ui,sans-serif;padding:16px}main{max-width:980px;margin:0 auto}h1{letter-spacing:-.02em}a{color:#f5c542;text-decoration:none}code{font-family:'Geist Mono',ui-monospace,monospace;color:#19f0d8;word-break:break-all}.card{background:rgba(20,19,24,.72);border:1px solid rgba(245,197,66,.16);border-radius:14px;padding:16px;margin:12px 0}button{background:#f5c542;color:#050506;border:0;border-radius:10px;padding:8px 14px;font-weight:600;cursor:pointer}input,select{background:#09090b;color:#f6f1e4;border:1px solid rgba(245,197,66,.3);border-radius:8px;padding:8px}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid rgba(245,197,66,.1);vertical-align:top;text-align:left;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.g{background:#19f0d8;box-shadow:0 0 8px #19f0d8}.r{background:#ff3d7f;box-shadow:0 0 8px #ff3d7f}.p{background:#5a5566}.dim{color:#9a927f;font-size:13px}.btn{display:inline-block;background:#f5c542;color:#050506;border-radius:10px;padding:6px 12px;font-weight:600}";
export var renderPage = (e, t) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono&display=swap"><style>${PAGE_CSS}</style></head><body><main>${t}</main></body></html>`;
var RAILWAY_VARS_PATH = "Railway \u2192 creator-os-runtime \u2192 runtime-svc \u2192 Variables";
var STATUS_CHECKS = [
  ["admin", "core", "Admin key (cockpit unlock + approvals)", "RUNTIME_ADMIN_KEY"],
  ["vault", "core", "Vault (encrypts stored secrets)", "VAULT_KEY (64 hex chars)"],
  ["railway", "core", "Deploys to Railway", "RAILWAY_API_TOKEN"],
  ["github", "hook", "GitHub webhook", "GITHUB_WEBHOOK_SECRET"],
  ["railwayWebhook", "hook", "Railway webhook", "RAILWAY_WEBHOOK_TOKEN"],
  ["mesh", "hook", "MeshMarket receipts", "MESH_RECEIPT_SECRET"],
  ["brain", "hook", "Brain webhook", "BRAIN_WEBHOOK_SECRET"],
  ["sync", "hook", "Memory sync (cognitive-mcp pulls)", "COG_SYNC_TOKEN"],
  ["stripe", "parked", "Stripe payments", "STRIPE_WEBHOOK_SECRET"],
  ["railwayOAuth", "parked", "Railway sign-in", "RAILWAY_OAUTH_CLIENT_ID + _SECRET"],
  ["brainOut", "parked", "Brain fan-out", "BRAIN_URL"],
  ["cognitiveBridge", "parked", "cognitive-mcp bridge push", "COG_BRIDGE_URL + COG_BRIDGE_TOKEN"],
];
var PRODUCT_PROBES = [
  ["DevDesk", "https://devdesk.meshtool.ai/health", "devdesk", "https://devdesk.meshtool.ai/runtime/connect"],
  ["MeshMarket", "https://market.meshtool.ai/api/health", "meshtool", null],
  ["MCP gate (Claude sign-in)", "https://mcp-gate-production.up.railway.app/health", null, null],
];
async function probeUrl(e) {
  let t = Date.now();
  try {
    let a = await fetch(e, {
      signal: AbortSignal.timeout(4000),
    });
    return {
      ok: a.ok,
      code: a.status,
      ms: Date.now() - t,
    };
  } catch (a) {
    return {
      ok: !1,
      code: 0,
      ms: Date.now() - t,
      why: String(a?.name || a),
    };
  }
}
// /status and /status.json are public and each report makes up to 4 outbound
// probes, so anyone could turn requests into outbound traffic. One report is
// shared for STATUS_TTL_MS, and concurrent callers share the one in flight
// (2026-09-25 fix).
var STATUS_TTL_MS = 60_000;
var statusCache = null;
export function buildStatusReport(now = Date.now()) {
  if (!statusCache || now - statusCache.at >= STATUS_TTL_MS) {
    const p = computeStatusReport();
    statusCache = { at: now, p };
    p.catch(() => { if (statusCache?.p === p) statusCache = null; });
  }
  return statusCache.p;
}
async function computeStatusReport() {
  let db = false;
  let consents = null;
  let marketReceiptSeen = null;
  const now = nowSec();
  try {
    await sql`SELECT 1`;
    db = true;
    consents = await sql`SELECT DISTINCT ON (g.sub) g.sub, r.created_at
      FROM oauth_refresh r
      JOIN grants g ON g.id = r.grant_id AND g.tenant = r.tenant
      JOIN grants root ON root.id = r.root_id AND root.tenant = r.tenant
      JOIN tenants t ON t.id = r.tenant
      WHERE r.revoked = false AND r.consent_until > ${now}
        AND g.status IN ('active', 'expired') AND root.status = 'active' AND root.exp > ${now}
        AND t.status = 'active'
        AND g.sub IN (${OAUTH_PROFILES.devdesk.sub}, ${OAUTH_PROFILES.meshtool.sub})
      ORDER BY g.sub, r.created_at DESC`;
    const [receipt] = await sql`SELECT EXISTS (SELECT 1 FROM webhook_events WHERE source = 'mesh' AND handled = true) AS seen`;
    marketReceiptSeen = receipt.seen;
  } catch {}
  const armed = armedIntegrations();
  const paused = await isKillSwitchOn().catch(() => null);
  const providers = [
    env.OLLAMA_URL && "Ollama",
    env.ANTHROPIC_API_KEY && "Anthropic",
    env.OPENAI_API_KEY && env.COG_OPENAI_MODEL && "OpenAI",
  ].filter(Boolean);
  const bodies = await Promise.all(PRODUCT_PROBES.map(async ([name, url, profile, connectUrl]) => {
    const probe = await probeUrl(url);
    const consent = profile && consents?.find((row) => row.sub === OAUTH_PROFILES[profile].sub);
    const connect = connectUrl && (consent || (await probeUrl(new URL("/runtime/status", connectUrl).href)).ok) ? connectUrl : null;
    const connection = !profile ? "not_required" : consents === null ? "unknown" : consent ? "consent_saved"
      : connect ? "needs_consent" : connectUrl ? "entry_unreachable" : "setup_unavailable";
    return {
      name, url, up: probe.ok, code: probe.code, ms: probe.ms, profile, connection,
      connected: profile && consents !== null ? !!consent : null,
      since: consent?.created_at || null, connect,
    };
  }));
  const checks = [
    { key: "db", kind: "core", label: "Database", ok: db, fix: db ? null : "Check Postgres in Railway" },
    { key: "kill", kind: "core", label: "Agent activity", ok: paused === false,
      fix: paused === null ? "Could not read the emergency stop setting" : paused ? "Review the emergency stop in Runtime" : null },
    { key: "cogPlanner", kind: "core", label: "COG planning", ok: true, fix: null, providers },
    ...STATUS_CHECKS.map(([key, kind, label, setting]) => ({
      key, kind, label, ok: !!armed[key], fix: armed[key] ? null : `Set ${setting} in ${RAILWAY_VARS_PATH}`,
      ...(key === "mesh" ? { deliverySeen: marketReceiptSeen } : {}),
    })),
  ];
  const red = checks.filter((check) => !check.ok && check.kind !== "parked").length +
    bodies.filter((body) => !body.up || (body.profile && body.connected !== true)).length;
  return {
    ok: red === 0, red, available: db, paused, version: VERSION,
    source: { sha256: sourceSha256, bytes: sourceBytes }, checks, bodies, time: new Date().toISOString(),
  };
}
export async function listDocNames() {
  return (await sql`SELECT name FROM docs ORDER BY name`).map((e) => e.name);
}
export async function getDoc(e) {
  let t = await sql`SELECT content FROM docs WHERE name = ${e}`;
  return t.length ? t[0].content : null;
}
export function markdownToHtml(e) {
  let t = (i) =>
      i.replace(
        /[&<>]/g,
        (o) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
          })[o],
      ),
    a = e.split(`
`),
    n = "",
    r = !1,
    s = !1;
  for (let i of a) {
    if (i.startsWith("```")) {
      ((n += r ? "</code></pre>" : "<pre><code>"), (r = !r));
      continue;
    }
    if (r) {
      n +=
        t(i) +
        `
`;
      continue;
    }
    // Escape the RAW line first, then apply the two markdown transforms on the
    // already-escaped text: `` ` `` and `*` are untouched by t(), so the
    // patterns still match, and their captured text is already safe. Escaping
    // used to run only inside fenced code / inline code spans, so a heading,
    // paragraph, list item or table cell carrying "<script>" rendered as a
    // live tag on every viewer of /docs/:name (stored XSS, 2026-09-25 fix).
    let E2 = t(i),
      o = E2
        .replace(/`([^`]+)`/g, (c, E) => `<code>${E}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (/^\|/.test(i)) {
      if (/^\|\s*-/.test(i)) continue;
      if (!s) ((n += "<table>"), (s = !0));
      n +=
        "<tr>" +
        E2
          .split("|")
          .slice(1, -1)
          .map((c) => `<td>${c.trim()}</td>`)
          .join("") +
        "</tr>";
      continue;
    } else if (s) ((n += "</table>"), (s = !1));
    let l = i.match(/^(#{1,3})\s+(.*)/);
    if (l) {
      n += `<h${l[1].length}>${t(l[2])}</h${l[1].length}>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(i)) {
      n += `<div>\u2022 ${o.replace(/^\s*[-*]\s+/, "")}</div>`;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(i)) {
      n += `<div>${o}</div>`;
      continue;
    }
    n += i.trim() ? `<p>${o}</p>` : "";
  }
  if (s) n += "</table>";
  return n;
}
