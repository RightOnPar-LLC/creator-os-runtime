// The Hono app, auth middleware (admin, grant, sync token), route inventory, source-hash state.
import { apiReceiptMiddleware, bindToolReceipt } from "./tool-receipts.js";
import { Hono } from "hono";
import { env } from "./config.js";
import { HttpError, hmacSha256, safeEqual, sha256Hex } from "./util.js";
import { verifyGrant } from "./grants.js";

// The entry point (index.js) hashes the file it was loaded from and hands the text here.
// Bundled for production, that file is the whole single-file runtime, as before the split.
export function recordSource(e) {
  ((sourceText = e),
    (sourceSha256 = sha256Hex(sourceText)),
    (sourceBytes = Buffer.byteLength(sourceText, "utf8")));
}
export var sourceSha256 = "unknown";
export var sourceBytes = 0;
export var sourceText = "";
export var app = new Hono();
app.use("/api/*", apiReceiptMiddleware(() => app.routes));
app.use("/auth/*", apiReceiptMiddleware(() => app.routes));
export var bearerToken = (e) => {
  let t = e.req.header("authorization") || "";
  return t.startsWith("Bearer ") ? t.slice(7).trim() : e.req.header("x-grant") || void 0;
};
// Admin auth reads ONLY the standard Authorization header. x-grant is the
// fallback channel for short-lived, revocable grant tokens (MCP clients that
// can't set Authorization); bearerToken() folds the two together, so the
// one master key could also authenticate over x-grant — a low-trust header
// never meant to carry it, and one more place it could be logged (2026-09-25 fix).
var adminHeaderToken = (e) => {
  let t = e.req.header("authorization") || "";
  return t.startsWith("Bearer ") ? t.slice(7).trim() : void 0;
};
var isAdminRequest = (e) =>
  !!env.RUNTIME_ADMIN_KEY && !!adminHeaderToken(e) && safeEqual(adminHeaderToken(e), env.RUNTIME_ADMIN_KEY);
var tagAuth = (e, t) =>
  Object.assign(e, {
    auth: t,
  });
// ---- The operator session (0.3.5) --------------------------------------------
// Before this, every /api/admin/* call and every cockpit data fetch carried the
// raw RUNTIME_ADMIN_KEY in an Authorization header. There was no session, so the
// owner re-pasted the master key into every new tab, on every machine, after
// every redeploy — the one secret that cannot be attenuated or revoked, typed
// over and over, which is exactly how a key ends up in a password manager's
// autofill, a screenshot or a shell history.
//
// A session is a stateless signed cookie: `<expMs>.<hmac>`, where the HMAC is
// taken over "admin-session|<expMs>" with RUNTIME_ADMIN_KEY ITSELF as the
// signing key. Nothing is stored: no table, no row to sweep, no state to
// replicate. Two properties fall out of that choice:
//
//   * The TTL is inside the signature. An expiry cannot be edited without
//     invalidating the HMAC, so a cookie cannot be stretched by its holder.
//   * ROTATING RUNTIME_ADMIN_KEY INVALIDATES EVERY OUTSTANDING SESSION, because
//     the key is the signing key. Key rotation is therefore the revoke-all
//     button; there is no session list to clear and none can be missed.
//
// A session cookie is exactly as strong as the key that signed it, so it is
// handed out only to a caller who already proved it holds that key, and it is
// set HttpOnly (script cannot read it) + Secure (never sent in clear) +
// SameSite=Lax (not sent on a cross-site POST).
export var SESSION_COOKIE = "cos_session";
var SESSION_CONTEXT = "admin-session|";
export var signSession = (expMs) =>
  `${expMs}.${hmacSha256(env.RUNTIME_ADMIN_KEY, `${SESSION_CONTEXT}${expMs}`)}`;
// Reads the cookie off the raw Cookie header (no new dependency: nothing in this
// repo imports hono/cookie). Returns a boolean and never throws — it sits in
// front of requireAdmin, so a malformed cookie must read as "no session", not
// as a 500 that locks the operator out of their own cockpit.
export function verifySessionCookie(e) {
  try {
    if (!env.RUNTIME_ADMIN_KEY) return !1;
    let t = e.req.header("cookie") || "";
    if (!t) return !1;
    let a;
    for (let r of t.split(";")) {
      let s = r.indexOf("=");
      if (s === -1) continue;
      if (r.slice(0, s).trim() === SESSION_COOKIE) a = r.slice(s + 1).trim();
    }
    if (!a) return !1;
    let n = a.indexOf(".");
    if (n <= 0 || n === a.length - 1) return !1;
    let i = a.slice(0, n),
      o = a.slice(n + 1);
    if (!/^[0-9]{1,15}$/.test(i)) return !1;
    let l = Number(i);
    if (!Number.isSafeInteger(l) || l <= Date.now()) return !1;
    return safeEqual(o, hmacSha256(env.RUNTIME_ADMIN_KEY, `${SESSION_CONTEXT}${i}`));
  } catch {
    return !1;
  }
}
export var requireAdmin = tagAuth(async (e, t) => {
  if (!env.RUNTIME_ADMIN_KEY)
    throw new HttpError(503, "unarmed", {
      needs: "RUNTIME_ADMIN_KEY",
    });
  // Either channel: the master key in Authorization (unchanged, and still the
  // only way to MINT a session), or a session cookie this runtime signed.
  if (!isAdminRequest(e) && !verifySessionCookie(e)) throw new HttpError(401, "admin_required");
  await bindToolReceipt(e, null, true, isAdminRequest(e) ? "operator_key" : "operator_session");
  await t();
}, "admin");
export var requireGrant = (e) =>
  tagAuth(
    async (t, a) => {
      const auth = await verifyGrant(bearerToken(t), e);
      t.set("auth", auth);
      await bindToolReceipt(t, auth, true);
      await a();
    },
    e ? `grant:${e}` : "grant",
  );
export var readJsonBody = async (e) => {
  try {
    return await e.req.json();
  } catch {
    return {};
  }
};
export var requireSyncToken = tagAuth(async (e, t) => {
  if (!env.COG_SYNC_TOKEN)
    throw new HttpError(503, "unarmed", {
      needs: "COG_SYNC_TOKEN",
    });
  let a = bearerToken(e);
  if (!a || !safeEqual(a, env.COG_SYNC_TOKEN)) throw new HttpError(401, "sync_token_required");
  await t();
}, "sync-token");
var ROUTE_AUTH_OVERRIDES = {
  "GET /cockpit/:page": "public(page)+admin(data)",
  "GET /auth/railway/callback": "public(state)",
  "POST /webhooks/stripe": "webhook:stripe-signature",
  "POST /webhooks/railway": "webhook:x-runtime-token",
  "POST /webhooks/github": "webhook:x-hub-signature-256",
  "POST /webhooks/brain": "webhook:x-brain-signature",
  "POST /webhooks/mesh": "webhook:x-mesh-signature",
  "POST /mcp": "grant (per tool; 401 -> OAuth)",
  "GET /oauth/authorize": "public(consent page)",
  "POST /oauth/register": "public(dcr, redirect allowlist)",
  "POST /oauth/token": "public(pkce/refresh)",
  "DELETE /api/deploys/:id": "grant:worker.delete (+breakglass in production)",
  "GET /sync/changes": "sync-token",
  "POST /sync/apply": "sync-token",
};
export function routeInventory() {
  let e = new Map();
  for (let t of app.routes) {
    if (t.method === "ALL") continue;
    let a = `${t.method} ${t.path}`,
      n = t.handler?.auth;
    e.set(a, ROUTE_AUTH_OVERRIDES[a] || n || e.get(a) || "public");
  }
  return [...e].map(([t, a]) => {
    let n = t.indexOf(" ");
    return {
      method: t.slice(0, n),
      path: t.slice(n + 1),
      auth: a,
    };
  });
}
