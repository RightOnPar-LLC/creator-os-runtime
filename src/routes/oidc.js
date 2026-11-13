// Routes: OIDC issuer for agent seats (src/oidc.js holds the signing). Registration order
// is significant. First consumer: Tailscale workload identity federation (Trust credentials ->
// Credential -> OpenID Connect -> Custom issuer, pointed at this runtime's issuer URL), so an
// agent seat can join the tailnet with a short-lived signed token instead of a static auth key.
//
//   GET  /.well-known/openid-configuration   discovery doc — PUBLIC, no auth (Tailscale fetches this)
//   GET  /.well-known/jwks.json              the public signing key — PUBLIC, no auth (ditto)
//   POST /api/admin/identity/oidc-token      mint an ID token for one seat — admin-only; refuses an
//                                            unseated, frozen, or quarantined seat the same way the
//                                            grant door already does (identity.js paperworkProblem)
import { app, readJsonBody, requireAdmin } from "../http.js";
import { publicBaseUrl } from "../oauth.js";
import { HttpError } from "../util.js";
import { getTenant, sql, recordEvent } from "../db.js";
import { paperworkProblem } from "../identity.js";
import { jwks, signIdToken, OIDC_ID_TOKEN_MAX_TTL_SEC } from "../oidc.js";

app.get("/.well-known/openid-configuration", (e) => {
  let iss = publicBaseUrl(e);
  return e.json({
    issuer: iss,
    jwks_uri: iss + "/.well-known/jwks.json",
    id_token_signing_alg_values_supported: ["ES256"],
    subject_types_supported: ["public"],
    response_types_supported: ["id_token"],
    // No authorization/token endpoints: this issuer doesn't run a browser login flow. Tokens are
    // minted directly for a seat the runtime already knows about (POST .../oidc-token, admin-only)
    // and handed to the workload to present to the relying party. Discovery exists so a relying
    // party (Tailscale) can fetch jwks_uri on its own schedule rather than being handed a key.
  });
});

app.get("/.well-known/jwks.json", (e) => e.json(jwks()));

app.post("/api/admin/identity/oidc-token", requireAdmin, async (e) => {
  let b = await readJsonBody(e);
  let tenantId = String(b?.tenant || "");
  let sub = String(b?.sub || "");
  let aud = String(b?.aud || "");
  if (!tenantId) throw new HttpError(400, "tenant_required");
  if (!sub) throw new HttpError(400, "sub_required");
  if (!aud) throw new HttpError(400, "aud_required", { hint: "the Client ID / audience Tailscale generated for this credential" });
  let t = await getTenant(tenantId);
  if (!t) throw new HttpError(404, "tenant_not_found");
  let seat = (await sql`SELECT * FROM agents WHERE tenant = ${tenantId} AND sub = ${sub}`)[0];
  let problem = paperworkProblem(seat ? { ...seat, seat: seat.sub } : null);
  if (seat?.status === "frozen") throw new HttpError(403, "agent_frozen", { sub, reason: seat.frozen_reason || void 0 });
  if (seat?.status === "quarantined") throw new HttpError(403, "agent_quarantined", { sub });
  if (problem) throw new HttpError(403, "identity_required", { reason: problem, sub });
  let ttlSec = Math.min(Math.max(1, Number(b?.ttlSec) || 300), OIDC_ID_TOKEN_MAX_TTL_SEC);
  let { token, exp, jti } = signIdToken({ issuer: publicBaseUrl(e), sub: `${tenantId}/${sub}`, aud, ttlSec });
  await recordEvent("identity.oidc_token_minted", { sub, aud, exp, jti }, tenantId, "admin");
  return e.json({ id_token: token, exp, token_type: "id_token" });
});
