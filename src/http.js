// The Hono app, auth middleware (admin, grant, sync token), route inventory, source-hash state.
import { Hono } from "hono";
import { env } from "./config.js";
import { HttpError, safeEqual, sha256Hex } from "./util.js";
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
export var bearerToken = (e) => {
  let t = e.req.header("authorization") || "";
  return t.startsWith("Bearer ") ? t.slice(7).trim() : e.req.header("x-grant") || void 0;
};
var isAdminRequest = (e) =>
  !!env.RUNTIME_ADMIN_KEY && !!bearerToken(e) && safeEqual(bearerToken(e), env.RUNTIME_ADMIN_KEY);
var tagAuth = (e, t) =>
  Object.assign(e, {
    auth: t,
  });
export var requireAdmin = tagAuth(async (e, t) => {
  if (!env.RUNTIME_ADMIN_KEY)
    throw new HttpError(503, "unarmed", {
      needs: "RUNTIME_ADMIN_KEY",
    });
  if (!isAdminRequest(e)) throw new HttpError(401, "admin_required");
  await t();
}, "admin");
export var requireGrant = (e) =>
  tagAuth(
    async (t, a) => {
      (t.set("auth", await verifyGrant(bearerToken(t), e)), await a());
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
  "POST /webhooks/railway": "webhook:?token=",
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
