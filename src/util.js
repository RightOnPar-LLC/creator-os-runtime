// Small pure helpers: JSON, time, ids, hashing, HMAC, constant-time compare, HTML escape, HttpError.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export var parseJson = (e) => (typeof e === "string" ? JSON.parse(e) : e);
export var nowSec = () => Math.floor(Date.now() / 1000);
export var newId = (e) => `${e}_${randomBytes(9).toString("base64url")}`;
export var sha256Hex = (e) => createHash("sha256").update(e).digest("hex");
export var toBase64Url = (e) => Buffer.from(e).toString("base64url");
export var hmacSha256 = (e, t, a = "hex") => createHmac("sha256", e).update(t).digest(a);
export function safeEqual(e, t) {
  let a = Buffer.from(e),
    n = Buffer.from(t);
  return a.length === n.length && timingSafeEqual(a, n);
}
export class HttpError extends Error {
  status;
  code;
  detail;
  constructor(e, t, a) {
    super(t);
    ((this.status = e), (this.code = t), (this.detail = a));
  }
}
export var sha256Base64Url = (e) => createHash("sha256").update(e).digest("base64url");
export var escapeHtml = (e) => String(e).replace(/[&<>"']/g, (t) => `&#${t.charCodeAt(0)};`);
