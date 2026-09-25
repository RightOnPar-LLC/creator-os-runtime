// Grant token signing (cog1.<payload>.<hmac>) and the AES-256-GCM vault.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env, SERVICE_NAME } from "./config.js";
import { hmacSha256, safeEqual, toBase64Url } from "./util.js";
import { getSetting, setSetting } from "./db.js";

var grantSigningKey;
export async function loadGrantSigningKey() {
  if (env.GRANT_SIGNING_KEY) return ((grantSigningKey = Buffer.from(env.GRANT_SIGNING_KEY, "utf8")), "env");
  let e = await getSetting("grant_signing_key");
  if (!e) ((e = randomBytes(32).toString("hex")), await setSetting("grant_signing_key", e));
  return ((grantSigningKey = Buffer.from(e, "hex")), "db");
}
export function signGrantToken(e) {
  return `cog1.${toBase64Url(e)}.${hmacSha256(grantSigningKey, e, "base64url")}`;
}
export function parseGrantToken(e) {
  try {
    let [t, a, n] = e.trim().split(".");
    if (t !== "cog1" || !a || !n) return null;
    let r = Buffer.from(a, "base64url").toString("utf8");
    if (!safeEqual(hmacSha256(grantSigningKey, r, "base64url"), n)) return null;
    let s = JSON.parse(r);
    if (s.iss !== SERVICE_NAME || s.v !== 1) return null;
    return {
      payload: s,
      json: r,
    };
  } catch {
    return null;
  }
}
export function vaultKey() {
  return /^[0-9a-f]{64}$/i.test(env.VAULT_KEY || "") ? Buffer.from(env.VAULT_KEY, "hex") : null;
}
export function vaultEncrypt(e) {
  let t = vaultKey();
  if (!t) throw Error("vault_unarmed");
  let a = randomBytes(12),
    n = createCipheriv("aes-256-gcm", t, a);
  return {
    ciphertext: Buffer.concat([n.update(e, "utf8"), n.final()]).toString("base64"),
    iv: a.toString("base64"),
    tag: n.getAuthTag().toString("base64"),
  };
}
export function vaultDecrypt(e) {
  let t = vaultKey();
  if (!t) throw Error("vault_unarmed");
  let a = createDecipheriv("aes-256-gcm", t, Buffer.from(e.iv, "base64"));
  return (
    a.setAuthTag(Buffer.from(e.tag, "base64")),
    Buffer.concat([a.update(Buffer.from(e.ciphertext, "base64")), a.final()]).toString("utf8")
  );
}
export function reissueGrantToken(e) {
  return signGrantToken(e.payload);
}
