// The public trust engine: signed, hash-chained receipts anyone can check.
//
// A receipt says "this happened" (a game run was replayed, a gauntlet passed, a call was settled)
// in a form a stranger can verify WITHOUT trusting this server: the body is canonical JSON, signed
// with Ed25519, and the public key is served at /.well-known/receipt-keys.json. Fetch the key once,
// and any receipt can be checked offline, forever. The ledger adds the second property: every
// receipt carries the hash of the one before it, so deleting or editing history breaks the chain.
//
// Deliberately separate from the other keys in this runtime:
//   tokens.js  cog1.* grant tokens, HMAC (symmetric) — only this runtime can check those
//   oidc.js    ES256 ID tokens for agent seats (OIDC relying parties want ES256/RS256)
//   here       Ed25519 receipts for the public — small, fast, supported by WebCrypto in browsers
// One key per job, so rotating or leaking one never touches the others.
//
// The keypair is generated once and kept in `settings` (same pattern as oidc.js), or supplied via
// RECEIPT_SIGNING_KEY (a PKCS8 PEM). The private half never leaves this process.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { env } from "./config.js";
import { getSetting, setSetting, sql } from "./db.js";
import { HttpError, newId, sha256Hex } from "./util.js";

export var RECEIPT_KID = "cos-rcpt-1"; // bump on rotation; old kids stay published so old receipts still verify
var RECEIPT_VERSION = 1;
var MAX_RESULT_BYTES = 4096;
var MAX_EVIDENCE = 20;
var KIND_RE = /^[a-z][a-z0-9_.-]{1,40}$/;

var privateKey, publicKey, publicJwk;

export async function loadReceiptSigningKey() {
  let pem = env.RECEIPT_SIGNING_KEY;
  if (!pem) {
    pem = await getSetting("receipt_signing_key");
    if (!pem) {
      let { privateKey: priv } = generateKeyPairSync("ed25519");
      pem = priv.export({ type: "pkcs8", format: "pem" });
      await setSetting("receipt_signing_key", pem);
    }
  }
  privateKey = createPrivateKey(pem);
  publicKey = createPublicKey(privateKey);
  let jwk = publicKey.export({ format: "jwk" });
  publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: RECEIPT_KID, use: "sig", alg: "EdDSA" };
  return env.RECEIPT_SIGNING_KEY ? "env" : "db";
}

export function receiptKeys() {
  if (!publicJwk) throw new HttpError(503, "receipt_signing_key_unloaded");
  return { keys: [publicJwk] };
}

// Canonical JSON: object keys sorted at every depth, no whitespace, no undefined, no non-finite
// numbers. The same object always yields the same bytes, so the signature can be re-checked by
// anyone who rebuilds the bytes (the verify page does exactly this in the browser).
export function canonicalJson(v) {
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new HttpError(400, "non_finite_number");
    return JSON.stringify(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x === undefined ? null : x)).join(",") + "]";
  if (typeof v === "object") {
    let keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  throw new HttpError(400, "unsupported_value");
}

function cleanEvidence(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, "bad_evidence", { hint: "an array of {kind, ref, sha256?}" });
  if (list.length > MAX_EVIDENCE) throw new HttpError(400, "too_much_evidence", { max: MAX_EVIDENCE });
  return list.map((e) => {
    let kind = String(e?.kind || ""), ref = String(e?.ref || "");
    if (!kind || kind.length > 40 || !ref || ref.length > 500) throw new HttpError(400, "bad_evidence_item");
    let out = { kind, ref };
    if (e.sha256 != null) {
      if (!/^[a-f0-9]{64}$/.test(String(e.sha256))) throw new HttpError(400, "bad_evidence_sha256");
      out.sha256 = String(e.sha256);
    }
    return out;
  });
}

function signBytes(bytes) {
  return nodeSign(null, Buffer.from(bytes), privateKey).toString("base64url");
}

// Issue one receipt. The chain is serialized with a transaction-scoped advisory lock, so two
// receipts issued at the same moment can never claim the same predecessor.
export async function issueReceipt({ kind, subject, result = {}, evidence = [], tenant = null, grant = null, isPublic = false, issuer }) {
  if (!privateKey) throw new HttpError(503, "receipt_signing_key_unloaded");
  kind = String(kind || "");
  if (!KIND_RE.test(kind)) throw new HttpError(400, "bad_kind", { hint: "lowercase, 2-41 chars, a-z 0-9 . _ -" });
  subject = String(subject || "");
  if (!subject || subject.length > 200) throw new HttpError(400, "bad_subject");
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new HttpError(400, "bad_result", { hint: "an object" });
  if (canonicalJson(result).length > MAX_RESULT_BYTES) throw new HttpError(400, "result_too_large", { max: MAX_RESULT_BYTES });
  let ev = cleanEvidence(evidence);
  let id = newId("rc");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7413201)`;
    let head = (await tx`SELECT seq, hash FROM signed_receipts ORDER BY seq DESC LIMIT 1`)[0];
    let seq = head ? Number(head.seq) + 1 : 1;
    let body = {
      v: RECEIPT_VERSION,
      id,
      seq,
      kind,
      issuer: issuer || "creator-os-runtime",
      subject,
      tenant: tenant || null,
      grant: grant || null,
      result,
      evidence: ev,
      issued_at: new Date().toISOString(),
      prev: head ? head.hash : null,
    };
    let canon = canonicalJson(body);
    let hash = sha256Hex(canon);
    let sig = signBytes(canon);
    await tx`INSERT INTO signed_receipts (id, seq, kind, tenant, public, body, hash, prev, sig, kid)
      VALUES (${id}, ${seq}, ${kind}, ${tenant || null}, ${!!isPublic}, ${canon}, ${hash}, ${body.prev}, ${sig}, ${RECEIPT_KID})`;
    return { receipt: body, hash, sig, kid: RECEIPT_KID, alg: "EdDSA" };
  });
}

function publicView(row) {
  return { receipt: JSON.parse(row.body), hash: row.hash, sig: row.sig, kid: row.kid, alg: "EdDSA" };
}

// Only receipts marked public are ever shown by id. A private receipt can still be verified by
// whoever holds it (they paste the whole thing), but its id alone reveals nothing — not even
// that it exists.
export async function getPublicReceipt(id) {
  if (!/^rc_[A-Za-z0-9_-]{6,40}$/.test(String(id || ""))) return null;
  let row = (await sql`SELECT * FROM signed_receipts WHERE id = ${id} AND public = true`)[0];
  return row ? publicView(row) : null;
}

// Check a receipt. Every check is reported separately so a person can see exactly what held:
//   key        the kid is one this runtime publishes
//   signature  Ed25519 over the canonical bytes, against that public key
//   ledger     this exact receipt (same hash) is in our ledger
//   chain      its `prev` is the hash of the receipt before it in the ledger (or null for #1)
// valid = all four. A receipt that is signed but missing from the ledger is reported as such,
// never silently passed.
export async function verifyReceipt({ receipt, sig, kid }) {
  if (!publicKey) throw new HttpError(503, "receipt_signing_key_unloaded");
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new HttpError(400, "receipt_required");
  if (typeof sig !== "string" || sig.length > 200) throw new HttpError(400, "sig_required");
  let canon;
  try {
    canon = canonicalJson(receipt);
  } catch {
    throw new HttpError(400, "bad_receipt");
  }
  let hash = sha256Hex(canon);
  let checks = { key: kid === RECEIPT_KID, signature: false, ledger: false, chain: false };
  if (checks.key) {
    try {
      checks.signature = nodeVerify(null, Buffer.from(canon), publicKey, Buffer.from(sig, "base64url"));
    } catch {
      checks.signature = false;
    }
  }
  let row = typeof receipt.id === "string" ? (await sql`SELECT seq, body, hash, prev FROM signed_receipts WHERE id = ${receipt.id}`)[0] : null;
  // Re-hash what is actually stored: a row whose body was edited but whose hash column was not
  // must not pass as "in the ledger".
  if (row && row.hash === hash && sha256Hex(row.body) === row.hash) {
    checks.ledger = true;
    let seq = Number(row.seq);
    if (seq === 1) checks.chain = row.prev === null && receipt.prev === null;
    else {
      let before = (await sql`SELECT hash FROM signed_receipts WHERE seq = ${seq - 1}`)[0];
      checks.chain = !!before && before.hash === row.prev && receipt.prev === row.prev;
    }
  }
  let valid = checks.key && checks.signature && checks.ledger && checks.chain;
  return { valid, checks, hash, kind: receipt.kind ?? null, issued_at: receipt.issued_at ?? null };
}

// Whole-ledger audit: walks every receipt in order, re-checks each signature and link.
export async function auditChain(limit = 5000) {
  let rows = await sql`SELECT id, seq, body, hash, prev, sig FROM signed_receipts ORDER BY seq ASC LIMIT ${limit}`;
  let prevHash = null, broken = null;
  for (let r of rows) {
    let ok = sha256Hex(r.body) === r.hash && r.prev === prevHash &&
      nodeVerify(null, Buffer.from(r.body), publicKey, Buffer.from(r.sig, "base64url"));
    if (!ok) { broken = { id: r.id, seq: Number(r.seq) }; break; }
    prevHash = r.hash;
  }
  return { checked: rows.length, intact: !broken, broken, head: prevHash };
}
