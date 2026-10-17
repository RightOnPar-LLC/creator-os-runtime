// sso.js - the runtime's half of the owner's ONE sign-in (DW, 2026-10-16).
//
// The owner signs in once, with Face ID, at id.meshtool.ai (RightOnPar-LLC/meshtool-frontdoor,
// owner.mjs). When the runtime does not know him yet it sends him there (GET /sso/start); id sends
// him back with a one-time PASS, posted to POST /sso/callback (routes/sso.js). This file checks it.
//
// verifyPass is COPIED from meshtool-frontdoor owner.mjs (feat/sso-id-faceid, 7aacfe7) so the
// runtime holds no code of id's but this one function, and only id's PUBLIC key (ID_PUBLIC_KEY):
// a runtime that is broken into still cannot make a pass. The caller must ALSO refuse a pass id
// (jti) it has already seen: a pass works once.
export const ID_ORIGIN = "https://id.meshtool.ai";
export const PASS_TTL = 60;
export const FACE_MAX = 180 * 86400;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64uToBytes = (s) => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4)); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };

export async function verifyPass(pass, { publicKey, audience, at = Math.floor(Date.now() / 1000) }) {
  const parts = String(pass || "").split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,2000}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[1])) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKey }, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, b64uToBytes(parts[1]), enc.encode(parts[0])))) return null;
    const c = JSON.parse(dec.decode(b64uToBytes(parts[0])));
    if (!c || c.v !== 1 || c.iss !== ID_ORIGIN || c.sub !== "owner" || c.aud !== audience) return null;
    if (typeof c.iat !== "number" || typeof c.exp !== "number" || c.exp - c.iat > PASS_TTL || at > c.exp || at < c.iat - 30) return null;
    if (typeof c.jti !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(c.jti) || typeof c.fa !== "number" || at > c.fa + FACE_MAX) return null;
    return c;
  } catch { return null; }
}

// Where the owner goes after the pass: a path on THIS site, or the cockpit.
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9_\-./?=&%~]*$/;
export function returnPath(origin, want) {
  try {
    const u = new URL(String(want || "").slice(0, 2000));
    if (u.origin === origin && !u.username && !u.password && SAFE_PATH.test(u.pathname + u.search)) return u.pathname + u.search;
  } catch { /* not an address */ }
  return "/";
}

// The link that starts a sign-in at id: back to `href` (a page on this site) afterwards. `after`:
// the owner signed out everywhere at that time, so id must see a Face ID newer than it.
export const signInAt = (origin, href, after = 0) => `${ID_ORIGIN}/sso/pass?${new URLSearchParams({ client: origin, return: href, ...(after ? { after: String(after) } : {}) })}`;

// SIGN OUT EVERYWHERE. id signs a notice "the owner signed out at T" and the phone hops through
// each site's GET /sso/signout. verifyNotice is COPIED from meshtool-frontdoor owner.mjs
// (feat/sso-signout-everywhere). Replaying one is harmless: the site keeps the LATEST T.
export const NOTICE_TTL = 600;
export async function verifyNotice(notice, { publicKey, at = Math.floor(Date.now() / 1000) }) {
  const parts = String(notice || "").split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,2000}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[1])) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKey }, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, b64uToBytes(parts[1]), enc.encode(parts[0])))) return null;
    const c = JSON.parse(dec.decode(b64uToBytes(parts[0])));
    if (!c || c.v !== 1 || c.iss !== ID_ORIGIN || c.sub !== "owner" || c.kind !== "signout" || c.aud !== undefined) return null;
    if (typeof c.iat !== "number" || typeof c.exp !== "number" || c.exp - c.iat > NOTICE_TTL || at > c.exp || at < c.iat - 30) return null;
    if (typeof c.at !== "number" || c.at !== c.iat) return null;
    return c;
  } catch { return null; }
}
// Where the sign-out hop sends the phone next: the runtime is the last hop, so only back to id's
// "signed out" page. Nothing else (so this is never an open redirect).
export const nextHop = () => `${ID_ORIGIN}/owner?out=1`;
