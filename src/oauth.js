// OAuth client profiles, redirect allow-list, grant issuance for OAuth clients.
import { randomBytes } from "crypto";
import { env } from "./config.js";
import { HttpError, nowSec, parseJson, sha256Hex } from "./util.js";
import { getGrant, getTenant, isOperatorLspCapsEnabled, sql } from "./db.js";
import { remainingBudget, TIERS } from "./policy.js";
import { issueChildGrant, mintRootGrant } from "./grants.js";

// deploy.worker + worker.status added 2026-09-26 so Claude (operator) and DevDesk
// can launch and watch workers. `deploys` is the per-grant deploy ceiling; it is
// still clamped to what the root has left.
export var OPERATOR_PROFILE = {
  sub: "agent:claude-operator",
  caps: [
    "grant.issue",
    "grant.read",
    "cog.plan",
    "ledger.read",
    "deploy.worker",
    "worker.status",
    "cog.execute",
    "lsp.diagnose",
  ],
  usd: 5000,
  calls: 500,
  deploys: 20,
  ttl: 604800,
  consent: 604800,
};
export var OAUTH_PROFILES = {
  operator: OPERATOR_PROFILE,
  devdesk: {
    sub: "product:devdesk",
    label: "DevDesk",
    caps: ["memory.read", "memory.write", "ledger.read", "tenant.read", "deploy.worker", "worker.status"],
    parts: ["agent:", "product:devdesk"],
    usd: 500,
    calls: 20000,
    deploys: 20,
    ttl: 86400,
    consent: 31536000,
  },
  meshtool: {
    sub: "product:meshtool",
    label: "MeshTool",
    caps: ["memory.read", "memory.write", "ledger.read", "webhook.emit"],
    parts: ["agent:", "product:meshtool"],
    usd: 500,
    calls: 20000,
    ttl: 86400,
    consent: 31536000,
  },
};
var PROFILE_BY_HOST = {
  "devdesk.meshtool.ai": "devdesk",
  "market.meshtool.ai": "meshtool",
};
// The profile a grant was APPROVED under, read back from the grant itself.
// Refresh must reuse exactly this — never re-derive from the client's
// registration, which can name several redirects (2026-09-25 fix: refresh used
// the client's FIRST redirect, so a client approved on devdesk could refresh
// into OPERATOR caps). Unknown sub → null → the caller fails closed.
export var profileForGrant = (g) => Object.values(OAUTH_PROFILES).find((p) => p.sub === g?.sub) || null;
export var profileForRedirect = (e) => {
  try {
    return OAUTH_PROFILES[PROFILE_BY_HOST[new URL(e).hostname]] || OPERATOR_PROFILE;
  } catch {
    return OPERATOR_PROFILE;
  }
};
var ALLOWED_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  ...Object.keys(PROFILE_BY_HOST),
  ...String(env.OAUTH_REDIRECT_HOSTS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean),
]);
export var publicBaseUrl = (e) =>
  env.PUBLIC_URL || `https://${e.req.header("x-forwarded-host") || e.req.header("host")}`;
export var isAllowedRedirectUri = (e) => {
  try {
    let t = new URL(e);
    return (
      (t.protocol === "https:" && ALLOWED_REDIRECT_HOSTS.has(t.hostname)) ||
      (t.protocol === "http:" && t.hostname === "localhost")
    );
  } catch {
    return !1;
  }
};
export var oauthError = (e, t, a, n = 400) =>
  e.json(
    {
      error: t,
      error_description: a,
    },
    n,
  );
export async function ensureRootGrant(e) {
  return (
    (
      await sql`SELECT * FROM grants WHERE tenant = ${e.id} AND depth = 0 AND status = 'active' AND exp > ${nowSec() + 3600} ORDER BY exp DESC LIMIT 1`
    )[0] || (await mintRootGrant(e)).row
  );
}
// Caps a profile actually gets, filtered against the live operator_lsp_caps
// toggle (default off, 2026-09-26). Only OPERATOR is ever filtered — every
// other profile is untouched. Shared by the approval-screen preview and the
// real grant mint so the two can never show/give different caps.
export async function effectiveCaps(a) {
  return a === OPERATOR_PROFILE && !(await isOperatorLspCapsEnabled())
    ? a.caps.filter((c) => c !== "cog.execute" && c !== "lsp.diagnose")
    : a.caps;
}
export async function issueOAuthGrant(e, t, a = OPERATOR_PROFILE) {
  let n = await getGrant(e),
    r = n && (await getTenant(n.tenant));
  if (!n || n.status !== "active" || Number(n.exp) <= nowSec() || !r)
    throw new HttpError(400, "root_inactive");
  let s = remainingBudget(n),
    i = Math.min(a.ttl, TIERS[r.tier].maxTtlSec, Number(n.exp) - nowSec(), t - nowSec()),
    caps = await effectiveCaps(a);
  return issueChildGrant(
    n,
    {
      sub: a.sub,
      caps,
      ...(a.parts
        ? {
            scope: {
              memory: {
                partitions: a.parts,
              },
            },
          }
        : {}),
      ttlSec: i,
      budget: {
        usd_cents: Math.min(a.usd, s.usd_cents),
        calls: Math.min(a.calls, s.calls),
        deploys: Math.max(0, Math.min(a.deploys || 0, s.deploys)),
      },
      constraints: {
        allowDelete: !1,
        requireDryRun: !0,
      },
    },
    "oauth",
  );
}
export var tokenResponse = (e, t, a = OPERATOR_PROFILE) => ({
  access_token: e.token,
  token_type: "Bearer",
  expires_in: Math.max(0, Number(e.row.exp) - nowSec()),
  refresh_token: t,
  scope: (parseJson(e.row.caps) || a.caps).join(" "),
});
export async function mintRefreshToken(e, t, a, n, r) {
  let s = randomBytes(32).toString("base64url");
  return (
    await sql`INSERT INTO oauth_refresh (hash, client_id, tenant, root_id, grant_id, consent_until) VALUES (${sha256Hex(s)}, ${e}, ${t}, ${a}, ${n}, ${r})`,
    s
  );
}
export var protectedResourceMetadata = (e) =>
  e.json({
    resource: publicBaseUrl(e) + "/mcp",
    authorization_servers: [publicBaseUrl(e)],
    scopes_supported: OPERATOR_PROFILE.caps,
    bearer_methods_supported: ["header"],
  });
export async function validateAuthorizeRequest(e) {
  let t = (await sql`SELECT * FROM oauth_clients WHERE id = ${String(e.client_id || "")}`)[0];
  if (!t) throw new HttpError(400, "unknown_client");
  if (!parseJson(t.redirect_uris).includes(String(e.redirect_uri || "")))
    throw new HttpError(400, "redirect_uri_mismatch");
  if (e.response_type && e.response_type !== "code") throw new HttpError(400, "unsupported_response_type");
  if (!e.code_challenge || (e.code_challenge_method || "S256") !== "S256")
    throw new HttpError(400, "pkce_s256_required");
  return t;
}
