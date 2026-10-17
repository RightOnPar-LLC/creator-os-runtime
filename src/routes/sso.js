// Routes: the owner's ONE sign-in (DW, 2026-10-16). Registration order is significant.
//
//   GET  /sso/start?return=/path   send the owner to id.meshtool.ai to sign in (Face ID there,
//                                  once); link here from the cockpit or any runtime page
//   POST /sso/callback             id posts a one-time pass here; it becomes the operator
//                                  session (cos_session), exactly as pasting the admin key does
//
// Both are off (404 / refused) until ID_PUBLIC_KEY is set: id's PUBLIC key, from
// https://id.meshtool.ai/.well-known/meshtool-id.json. The runtime never holds anything that
// can make a pass. A pass works once (sso_passes, keyed by its jti).
import { env } from "../config.js";
import { sql } from "../db.js";
import { app, ownerNotBefore, sessionCookie, signSession, SESSION_TTL_SEC } from "../http.js";
import { verifyPass, verifyNotice, nextHop, returnPath, signInAt, ID_ORIGIN, FACE_MAX } from "../sso.js";

// The name id knows this runtime by (its CLIENTS list). A pass for any other name is refused.
export var SSO_SELF = "https://runtime.meshtool.ai";
var toCockpit = (e, why) => (e.header("cache-control", "no-store"), e.header("referrer-policy", "no-referrer"), e.redirect(`/?sso=${why}`, 303));

app.get("/sso/start", async (e) => {
  if (!env.ID_PUBLIC_KEY) return e.json({ error: "sso_off" }, 404);
  let want = String(e.req.query("return") || "/");
  let back = returnPath(SSO_SELF, SSO_SELF + (want.startsWith("/") ? want : "/"));
  e.header("cache-control", "no-store");
  e.header("referrer-policy", "no-referrer");
  return e.redirect(signInAt(SSO_SELF, SSO_SELF + back, await ownerNotBefore()), 302);
});

// SIGN OUT EVERYWHERE: the last hop of id's notice. Keeps the LATEST time (an older notice never
// moves it back); from then on requireAdmin refuses any operator session made before it, however
// it was made (the admin key pasted, or a pass). The admin key itself is untouched.
app.get("/sso/signout", async (e) => {
  e.header("cache-control", "no-store");
  e.header("referrer-policy", "no-referrer");
  if (!env.ID_PUBLIC_KEY) return e.json({ error: "sso_off" }, 404);
  let n = await verifyNotice(e.req.query("notice"), { publicKey: env.ID_PUBLIC_KEY });
  if (!n) return e.json({ error: "notice_refused" }, 403);
  await sql`INSERT INTO settings (key, value, updated_at) VALUES ('owner_not_before', ${String(n.at)}, now())
           ON CONFLICT (key) DO UPDATE SET value = GREATEST(settings.value::bigint, EXCLUDED.value::bigint)::text, updated_at = now()`;
  e.header("set-cookie", sessionCookie("", 0));
  return e.redirect(nextHop(), 303);
});

app.post("/sso/callback", async (e) => {
  if (!env.ID_PUBLIC_KEY || !env.RUNTIME_ADMIN_KEY) return toCockpit(e, "off");
  if (e.req.header("origin") !== ID_ORIGIN) return toCockpit(e, "refused");
  if (Number(e.req.header("content-length") || 0) > 4096) return toCockpit(e, "refused");
  let raw = await e.req.text();
  if (raw.length > 4096) return toCockpit(e, "refused");
  let form = new URLSearchParams(raw);
  let c = await verifyPass(form.get("pass"), { publicKey: env.ID_PUBLIC_KEY, audience: SSO_SELF });
  if (!c) return toCockpit(e, "refused");
  // Signed out everywhere since that Face ID: back to id for a newer one (not a dead end).
  let T = await ownerNotBefore();
  if (T && c.fa <= T) {
    e.header("cache-control", "no-store");
    e.header("referrer-policy", "no-referrer");
    return e.redirect(signInAt(SSO_SELF, SSO_SELF + returnPath(SSO_SELF, form.get("return")), T), 303);
  }
  // A pass works ONCE: the INSERT that returns no row is the replay.
  await sql`CREATE TABLE IF NOT EXISTS sso_passes (jti text PRIMARY KEY, exp bigint NOT NULL)`;
  let fresh = await sql`INSERT INTO sso_passes (jti, exp) VALUES (${c.jti}, ${c.exp}) ON CONFLICT DO NOTHING RETURNING jti`;
  if (!fresh.length) return toCockpit(e, "refused");
  await sql`DELETE FROM sso_passes WHERE exp < ${Math.floor(Date.now() / 1000) - 3600}`;
  // The session never outlives id's face check by more than FACE_MAX at the moment it is made.
  let expMs = Math.min(Date.now() + SESSION_TTL_SEC * 1000, (c.fa + FACE_MAX) * 1000);
  e.header("set-cookie", sessionCookie(signSession(expMs), Math.floor((expMs - Date.now()) / 1000)));
  e.header("cache-control", "no-store");
  e.header("referrer-policy", "no-referrer");
  return e.redirect(returnPath(SSO_SELF, form.get("return")), 303);
});
