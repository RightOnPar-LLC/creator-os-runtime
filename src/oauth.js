// OAuth client profiles, redirect allow-list, grant issuance for OAuth clients.
import { randomBytes } from "crypto";
import { env } from "./config.js";
import { HttpError, nowSec, parseJson, sha256Hex } from "./util.js";
import { getGrant, getTenant, recordEvent, sql } from "./db.js";
import { remainingBudget, TIERS } from "./policy.js";
import { issueChildGrant, mintRootGrant } from "./grants.js";
import { isOperatorExecOn, OPERATOR_EXEC_CAPS, OPERATOR_EXEC_SETTING, OPERATOR_SUB } from "./operator.js";

export { isOperatorExecOn, OPERATOR_EXEC_CAPS, OPERATOR_EXEC_SETTING };

export var OPERATOR_PROFILE = {
  sub: OPERATOR_SUB,
  caps: ["grant.issue", "grant.read", "cog.plan", "ledger.read"],
  usd: 5000,
  calls: 500,
  ttl: 604800,
  consent: 604800,
};
export var OAUTH_PROFILES = {
  operator: OPERATOR_PROFILE,
  devdesk: {
    sub: "product:devdesk",
    label: "DevDesk",
    caps: ["memory.read", "memory.write", "ledger.read", "tenant.read"],
    parts: ["agent:", "product:devdesk"],
    usd: 500,
    calls: 20000,
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
// 0.3.3: the caps a profile is issued with right now. Only the operator profile
// varies: with the admin toggle on it also gets OPERATOR_EXEC_CAPS, but only those
// the root grant it is minted under actually carries (roots minted before 0.3.2 lack
// lsp.*); the rest are dropped, never an attenuation failure.
export async function resolveProfileCaps(e, t) {
  if (e !== OPERATOR_PROFILE || !(await isOperatorExecOn()))
    return {
      caps: [...e.caps],
      dropped: [],
    };
  let a = parseJson(t?.caps || []),
    n = OPERATOR_EXEC_CAPS.filter((r) => !e.caps.includes(r));
  return {
    caps: [...e.caps, ...n.filter((r) => a.includes(r))],
    dropped: n.filter((r) => !a.includes(r)),
  };
}
// The operator caps advertised in OAuth metadata (scopes_supported).
export async function operatorScopes() {
  return (await isOperatorExecOn()) ? [...OPERATOR_PROFILE.caps, ...OPERATOR_EXEC_CAPS] : OPERATOR_PROFILE.caps;
}
export async function issueOAuthGrant(e, t, a = OPERATOR_PROFILE) {
  let n = await getGrant(e),
    r = n && (await getTenant(n.tenant));
  if (!n || n.status !== "active" || Number(n.exp) <= nowSec() || !r)
    throw new HttpError(400, "root_inactive");
  let s = remainingBudget(n),
    i = Math.min(a.ttl, TIERS[r.tier].maxTtlSec, Number(n.exp) - nowSec(), t - nowSec()),
    o = await resolveProfileCaps(a, n);
  if (o.dropped.length)
    await recordEvent(
      "operator_exec.caps_dropped",
      {
        root: n.id,
        dropped: o.dropped,
      },
      r.id,
      "oauth",
    );
  return issueChildGrant(
    n,
    {
      sub: a.sub,
      caps: o.caps,
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
        deploys: 0,
      },
      constraints: {
        allowDelete: !1,
        requireDryRun: !0,
      },
    },
    "oauth",
  );
}
// scope = the caps the issued grant actually carries (0.3.3: may differ from the
// profile's base caps while the operator exec toggle is on).
export var tokenResponse = (e, t) => ({
  access_token: e.token,
  token_type: "Bearer",
  expires_in: Math.max(0, Number(e.row.exp) - nowSec()),
  refresh_token: t,
  scope: parseJson(e.row.caps).join(" "),
});
export async function mintRefreshToken(e, t, a, n, r) {
  let s = randomBytes(32).toString("base64url");
  return (
    await sql`INSERT INTO oauth_refresh (hash, client_id, tenant, root_id, grant_id, consent_until) VALUES (${sha256Hex(s)}, ${e}, ${t}, ${a}, ${n}, ${r})`,
    s
  );
}
export var protectedResourceMetadata = async (e) =>
  e.json({
    resource: publicBaseUrl(e) + "/mcp",
    authorization_servers: [publicBaseUrl(e)],
    scopes_supported: await operatorScopes(),
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
