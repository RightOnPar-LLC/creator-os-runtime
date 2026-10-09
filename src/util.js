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
// A query string can carry a shared secret (e.g. POST /webhooks/railway?token=...,
// the only auth channel Railway project webhooks can use -- they send no custom
// headers). Any request URL logged anywhere in this runtime goes through this
// first, so that secret never reaches a log line (2026-09-25 fix).
export var redactUrl = (e) => {
  let t = String(e ?? ""),
    a = t.indexOf("?");
  return a === -1 ? t : t.slice(0, a);
};
// A stored deploy/approval `intent` is the caller's request body, and its `env`
// carries real values (other services' keys). The runtime already holds them;
// no reader ever needs them back. Readers get the variable NAMES so a cockpit can
// still show what was set. Any other top-level string field named like a secret
// is masked too. The stored row is untouched: an approved deploy still runs with
// the real values (routes/grants.js reads ap.intent from the database, not from
// this). Shared by GET /api/deploys/:id and GET /api/approvals (2026-10-09).
var SECRET_NAME = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i;
export var REDACTED = "[redacted]";
export function redactIntent(e) {
  let t;
  try {
    t = parseJson(e);
  } catch {
    return null;
  }
  if (!t || typeof t !== "object" || Array.isArray(t)) return t ?? null;
  let a = {};
  for (let [n, r] of Object.entries(t))
    if (n === "env") a.env = r && typeof r === "object" && !Array.isArray(r) ? Object.fromEntries(Object.keys(r).map((s) => [s, REDACTED])) : REDACTED;
    else a[n] = typeof r === "string" && SECRET_NAME.test(n) ? REDACTED : r;
  return a;
}
export var withRedactedIntent = (e) => (e ? { ...e, intent: redactIntent(e.intent) } : e);
