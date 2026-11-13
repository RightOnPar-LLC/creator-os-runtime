// OIDC issuer for agent seats: lets a seat prove its identity to an outside relying party
// (Tailscale workload identity federation is the first consumer) using a short-lived,
// asymmetrically-signed ID token instead of a shared secret.
//
// Deliberately separate from tokens.js (cog1.* grant tokens, HMAC-signed, symmetric — verified
// only by this runtime) and from sso.js (Ed25519, verifies passes FROM id.meshtool.ai). This
// module is the one place in the estate that signs a token meant to be verified by someone
// else's infrastructure, so it uses a real asymmetric algorithm a third party can check against
// a published public key, never the shared grant-signing secret.
//
// ES256 (ECDSA P-256), not Ed25519: third-party OIDC relying parties (Tailscale's custom-issuer
// support included) commonly require RS256 or ES256; EdDSA support is inconsistent. ES256 keeps
// the keys and tokens small without needing an RSA keygen.
//
// The keypair is generated once and kept in `settings` (same persistence pattern as
// grant_signing_key in tokens.js), or supplied via OIDC_SIGNING_KEY (a PKCS8 PEM) for an operator
// who wants to manage rotation themselves. Either way the private half never leaves this process;
// only the public half is ever served, at /.well-known/jwks.json.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign } from "node:crypto";
import { env, SERVICE_NAME } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { HttpError, nowSec, toBase64Url } from "./util.js";

var KID = "cos-oidc-1"; // bump if the key is ever rotated to a new keypair, so old JWKS caches miss cleanly
var ID_TOKEN_MAX_TTL_SEC = 900; // 15 min: an ID token is handed to Tailscale and exchanged immediately, not held

var privateKey, publicJwk;

export async function loadOidcSigningKey() {
  let pem = env.OIDC_SIGNING_KEY;
  if (!pem) {
    pem = await getSetting("oidc_signing_key");
    if (!pem) {
      let { privateKey: priv } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      pem = priv.export({ type: "pkcs8", format: "pem" });
      await setSetting("oidc_signing_key", pem);
    }
  }
  privateKey = createPrivateKey(pem);
  let pub = createPublicKey(privateKey).export({ format: "jwk" });
  publicJwk = { ...pub, kid: KID, use: "sig", alg: "ES256" };
  return env.OIDC_SIGNING_KEY ? "env" : "db";
}

export function jwks() {
  if (!publicJwk) throw new HttpError(503, "oidc_signing_key_unloaded");
  return { keys: [publicJwk] };
}

// DER (what node's sign() returns for EC) -> raw r||s (what JWS ES256 requires). P-256 => 32 bytes each.
function derToJoseEcdsa(der) {
  let offset = 2,
    readInt = () => {
      if (der[offset] !== 0x02) throw new Error("bad_der");
      let len = der[offset + 1];
      offset += 2;
      let bytes = der.subarray(offset, offset + len);
      offset += len;
      return bytes.length > 32 ? bytes.subarray(bytes.length - 32) : Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
    };
  return Buffer.concat([readInt(), readInt()]);
}

// Signs an OIDC ID token for one agent seat. Callers MUST have already checked the seat is
// active and unfrozen (routes/identity.js does this via identity.js before calling in) — this
// function only signs what it's given; it enforces nothing about who the subject is.
export function signIdToken({ issuer, sub, aud, ttlSec = 300, extra = {} }) {
  if (!privateKey) throw new HttpError(503, "oidc_signing_key_unloaded");
  if (!sub || typeof sub !== "string" || sub.length > 200) throw new HttpError(400, "bad_sub");
  if (!aud || typeof aud !== "string" || aud.length > 200) throw new HttpError(400, "bad_aud");
  let ttl = Math.min(Math.max(1, Number(ttlSec) || 300), ID_TOKEN_MAX_TTL_SEC);
  let iat = nowSec();
  let header = { alg: "ES256", typ: "JWT", kid: KID };
  let payload = { iss: issuer, sub, aud, iat, exp: iat + ttl, jti: randomBytes(12).toString("base64url"), ...extra };
  let signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  let der = nodeSign(null, Buffer.from(signingInput), { key: privateKey, dsaEncoding: "der" });
  let sig = derToJoseEcdsa(der).toString("base64url");
  return { token: `${signingInput}.${sig}`, exp: payload.exp, jti: payload.jti };
}

export var OIDC_ID_TOKEN_MAX_TTL_SEC = ID_TOKEN_MAX_TTL_SEC;
