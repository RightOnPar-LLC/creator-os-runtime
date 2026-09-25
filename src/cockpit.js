// HTML page shell, status report (product probes), docs store and markdown renderer.
import { armedIntegrations, VERSION } from "./config.js";
import { nowSec, parseJson } from "./util.js";
import { isKillSwitchOn, sql } from "./db.js";
import { sourceBytes, sourceSha256 } from "./http.js";
import { OAUTH_PROFILES, profileForRedirect } from "./oauth.js";

var PAGE_CSS =
  "body{margin:0;background:#050506;color:#f6f1e4;font:15px/1.5 Geist,system-ui,sans-serif;padding:16px}main{max-width:980px;margin:0 auto}h1{letter-spacing:-.02em}a{color:#f5c542;text-decoration:none}code{font-family:'Geist Mono',ui-monospace,monospace;color:#19f0d8;word-break:break-all}.card{background:rgba(20,19,24,.72);border:1px solid rgba(245,197,66,.16);border-radius:14px;padding:16px;margin:12px 0}button{background:#f5c542;color:#050506;border:0;border-radius:10px;padding:8px 14px;font-weight:600;cursor:pointer}input,select{background:#09090b;color:#f6f1e4;border:1px solid rgba(245,197,66,.3);border-radius:8px;padding:8px}table{border-collapse:collapse;width:100%}td{padding:8px;border-bottom:1px solid rgba(245,197,66,.1);vertical-align:top}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.g{background:#19f0d8;box-shadow:0 0 8px #19f0d8}.r{background:#ff3d7f;box-shadow:0 0 8px #ff3d7f}.p{background:#5a5566}.dim{color:#9a927f;font-size:13px}.btn{display:inline-block;background:#f5c542;color:#050506;border-radius:10px;padding:6px 12px;font-weight:600}";
export var renderPage = (e, t) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono&display=swap"><style>${PAGE_CSS}</style></head><body><main>${t}</main></body></html>`;
var RAILWAY_VARS_PATH = "Railway \u2192 creator-os-runtime \u2192 runtime \u2192 Variables";
var STATUS_CHECKS = [
  ["admin", "core", "Admin key (cockpit unlock + approvals)", "RUNTIME_ADMIN_KEY"],
  ["vault", "core", "Vault (encrypts stored secrets)", "VAULT_KEY (64 hex chars)"],
  ["anthropic", "core", "COG brain (plans work)", "ANTHROPIC_API_KEY"],
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
export async function buildStatusReport() {
  let e = !1,
    t = [];
  try {
    (await sql`SELECT 1`,
      (e = !0),
      (t =
        await sql`SELECT DISTINCT ON (c.id) c.id, c.name, c.redirect_uris, r.consent_until, r.created_at, g.status AS gstatus, g.exp AS gexp
      FROM oauth_refresh r JOIN oauth_clients c ON c.id = r.client_id LEFT JOIN grants g ON g.id = r.grant_id
      WHERE r.revoked = false AND r.consent_until > ${nowSec()} ORDER BY c.id, r.created_at DESC`));
  } catch {}
  let a = armedIntegrations(),
    n = await isKillSwitchOn().catch(() => !1),
    r = await Promise.all(
      PRODUCT_PROBES.map(async ([o, l, c, E]) => {
        let T = await probeUrl(l),
          R = c && t.find((B) => profileForRedirect(parseJson(B.redirect_uris)[0]) === OAUTH_PROFILES[c]),
          S = E && !R ? (await probeUrl(new URL("/runtime/status", E).href)).ok : !!E;
        return {
          name: o,
          url: l,
          up: T.ok,
          code: T.code,
          ms: T.ms,
          profile: c,
          connected: c ? !!R : null,
          since: R?.created_at || null,
          connect: S ? E : null,
        };
      }),
    ),
    s = STATUS_CHECKS.map(([o, l, c, E]) => ({
      key: o,
      kind: l,
      label: c,
      ok: !!a[o],
      fix: a[o] ? null : `Set ${E} in ${RAILWAY_VARS_PATH}`,
    }));
  s.unshift(
    {
      key: "db",
      kind: "core",
      label: "Database",
      ok: e,
      fix: e ? null : "Check the Postgres service in Railway",
    },
    {
      key: "kill",
      kind: "core",
      label: "Kill switch off",
      ok: !n,
      fix: n ? "Cockpit \u2192 Resume (runtime is paused)" : null,
    },
  );
  let i =
    s.filter((o) => !o.ok && o.kind !== "parked").length +
    r.filter((o) => !o.up || o.connected === !1).length;
  return {
    ok: i === 0,
    red: i,
    version: VERSION,
    source: {
      sha256: sourceSha256,
      bytes: sourceBytes,
    },
    checks: s,
    bodies: r,
    time: new Date().toISOString(),
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
    let o = i
      .replace(/`([^`]+)`/g, (c, E) => `<code>${t(E)}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (/^\|/.test(i)) {
      if (/^\|\s*-/.test(i)) continue;
      if (!s) ((n += "<table>"), (s = !0));
      n +=
        "<tr>" +
        i
          .split("|")
          .slice(1, -1)
          .map((c) => `<td>${c.trim()}</td>`)
          .join("") +
        "</tr>";
      continue;
    } else if (s) ((n += "</table>"), (s = !1));
    let l = i.match(/^(#{1,3})\s+(.*)/);
    if (l) {
      n += `<h${l[1].length}>${l[2]}</h${l[1].length}>`;
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
