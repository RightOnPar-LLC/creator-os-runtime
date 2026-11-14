// The public trust engine (src/receipts.js, src/routes/receipts.js): Ed25519-signed, hash-chained
// receipts that anyone can verify — on our verify route, and offline against the published key.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll } from "bun:test";
import { webcrypto } from "node:crypto";
import { req, admin, dbQuery, shutdown } from "./harness.js";

afterAll(shutdown);

const canon = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x === undefined ? null : x)).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
};
async function offlineVerify(env, jwk) {
  const key = await webcrypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  return webcrypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(env.sig, "base64url"), new TextEncoder().encode(canon(env.receipt)));
}
const issue = (body) => admin("POST", "/api/admin/receipts", { body });
const run = (extra = {}) => issue({ kind: "game.run", subject: "mesh-city:player-1", result: { orbs: 31, of: 33, ms: 74210 },
  evidence: [{ kind: "github", ref: "Meshtool/godot-starter-3d", sha256: "a".repeat(64) }], ...extra });

let jwk;
describe("receipts: the public key is published", () => {
  test("receipt-keys.json: one Ed25519 public key, no auth, never the private half", async () => {
    const r = await req("GET", "/.well-known/receipt-keys.json");
    expect(r.status).toBe(200);
    expect(r.json.keys.length).toBe(1);
    jwk = r.json.keys[0];
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(jwk.alg).toBe("EdDSA");
    expect(jwk.kid).toBe("cos-rcpt-1");
    expect(jwk.d).toBeUndefined();
  });

  test("it is not the OIDC key (one key per job)", async () => {
    const o = (await req("GET", "/.well-known/jwks.json")).json.keys[0];
    expect(o.kid).not.toBe(jwk.kid);
    expect(o.x).not.toBe(jwk.x);
  });
});

describe("receipts: issuing", () => {
  test("admin-only", async () => {
    const r = await req("POST", "/api/admin/receipts", { body: { kind: "game.run", subject: "x" } });
    expect(r.status).toBe(401);
  });

  test("rejects a bad kind, subject, result and evidence", async () => {
    expect((await issue({ kind: "Bad Kind", subject: "x" })).json.error).toBe("bad_kind");
    expect((await issue({ kind: "game.run", subject: "" })).json.error).toBe("bad_subject");
    expect((await issue({ kind: "game.run", subject: "x", result: [1] })).json.error).toBe("bad_result");
    expect((await issue({ kind: "game.run", subject: "x", evidence: [{ kind: "g" }] })).json.error).toBe("bad_evidence_item");
    expect((await issue({ kind: "game.run", subject: "x", evidence: [{ kind: "g", ref: "r", sha256: "nope" }] })).json.error).toBe("bad_evidence_sha256");
    expect((await issue({ kind: "game.run", subject: "x", result: { blob: "z".repeat(5000) } })).json.error).toBe("result_too_large");
  });

  test("a receipt verifies on the route AND offline against the published key", async () => {
    const r = await run();
    expect(r.status).toBe(201);
    expect(r.json.kid).toBe("cos-rcpt-1");
    expect(r.json.receipt.id).toMatch(/^rc_/);
    expect(await offlineVerify(r.json, jwk)).toBe(true);
    const v = await req("POST", "/api/receipts/verify", { body: { receipt: r.json.receipt, sig: r.json.sig, kid: r.json.kid } });
    expect(v.status).toBe(200);
    expect(v.json.valid).toBe(true);
    expect(v.json.checks).toEqual({ key: true, signature: true, ledger: true, chain: true });
    expect(v.json.hash).toBe(r.json.hash);
  });
});

describe("receipts: tampering is caught", () => {
  test("change one number in the result: signature and ledger both fail, offline too", async () => {
    const r = await run();
    const forged = { ...r.json.receipt, result: { ...r.json.receipt.result, orbs: 33 } };
    expect(await offlineVerify({ ...r.json, receipt: forged }, jwk)).toBe(false);
    const v = await req("POST", "/api/receipts/verify", { body: { receipt: forged, sig: r.json.sig, kid: r.json.kid } });
    expect(v.json.valid).toBe(false);
    expect(v.json.checks.signature).toBe(false);
    expect(v.json.checks.ledger).toBe(false);
  });

  test("an unknown key id fails the key check", async () => {
    const r = await run();
    const v = await req("POST", "/api/receipts/verify", { body: { receipt: r.json.receipt, sig: r.json.sig, kid: "someone-else" } });
    expect(v.json.valid).toBe(false);
    expect(v.json.checks.key).toBe(false);
    expect(v.json.checks.signature).toBe(false);
  });

  test("a garbage signature fails cleanly, no 500", async () => {
    const r = await run();
    const v = await req("POST", "/api/receipts/verify", { body: { receipt: r.json.receipt, sig: "AAAA", kid: r.json.kid } });
    expect(v.status).toBe(200);
    expect(v.json.checks.signature).toBe(false);
  });

  test("missing pieces are a 400, not a pass", async () => {
    expect((await req("POST", "/api/receipts/verify", { body: {} })).json.error).toBe("receipt_required");
    expect((await req("POST", "/api/receipts/verify", { body: { receipt: { a: 1 } } })).json.error).toBe("sig_required");
  });
});

describe("receipts: the chain", () => {
  test("each receipt points at the one before it, in order", async () => {
    const a = (await run()).json, b = (await run()).json, c = (await run()).json;
    expect(b.receipt.seq).toBe(a.receipt.seq + 1);
    expect(c.receipt.seq).toBe(b.receipt.seq + 1);
    expect(b.receipt.prev).toBe(a.hash);
    expect(c.receipt.prev).toBe(b.hash);
  });

  test("ten issued at once still make one straight chain", async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () => run()));
    expect(all.every((r) => r.status === 201)).toBe(true);
    const seqs = all.map((r) => r.json.receipt.seq).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(10);
    const audit = await admin("GET", "/api/admin/receipts/audit");
    expect(audit.json.intact).toBe(true);
    expect(audit.json.checked).toBeGreaterThanOrEqual(15);
  });

  test("editing history in the database breaks the audit at that exact receipt", async () => {
    const r = (await run()).json;
    const after = (await run()).json;
    await dbQuery("UPDATE signed_receipts SET body = replace(body, '\"orbs\":31', '\"orbs\":33') WHERE id = $1", [r.receipt.id]);
    const audit = await admin("GET", "/api/admin/receipts/audit");
    expect(audit.json.intact).toBe(false);
    expect(audit.json.broken.id).toBe(r.receipt.id);
    const v = await req("POST", "/api/receipts/verify", { body: { receipt: r.receipt, sig: r.sig, kid: r.kid } });
    expect(v.json.checks.ledger).toBe(false);
    expect(v.json.valid).toBe(false);
    // the honest receipt after it still has a good signature; its link names the ORIGINAL hash
    expect(await offlineVerify(after, jwk)).toBe(true);
    expect(after.receipt.prev).toBe(r.hash);
  });
});

describe("receipts: public vs private", () => {
  test("a private receipt is invisible by id, but whoever holds it can still verify it", async () => {
    const r = (await run()).json;
    expect((await req("GET", "/api/receipts/" + r.receipt.id)).status).toBe(404);
    expect((await req("POST", "/api/receipts/verify", { body: { id: r.receipt.id } })).status).toBe(404);
    const v = await req("POST", "/api/receipts/verify", { body: { receipt: r.receipt, sig: r.sig, kid: r.kid } });
    expect(v.json.valid).toBe(true);
  });

  test("a public receipt can be fetched and checked by id alone", async () => {
    const r = (await run({ public: true })).json;
    const g = await req("GET", "/api/receipts/" + r.receipt.id);
    expect(g.status).toBe(200);
    expect(g.json.sig).toBe(r.sig);
    expect(await offlineVerify(g.json, jwk)).toBe(true);
    const v = await req("POST", "/api/receipts/verify", { body: { id: r.receipt.id } });
    expect(v.json.valid).toBe(true);
  });

  test("a malformed id is a plain 404", async () => {
    expect((await req("GET", "/api/receipts/'; drop table")).status).toBe(404);
  });
});

describe("receipts: the human page", () => {
  test("/verify and /verify/:id serve the page, styled, with the in-browser check", async () => {
    for (const p of ["/verify", "/verify/rc_abcdefgh"]) {
      const r = await req("GET", p);
      expect(r.status).toBe(200);
      expect(r.text).toContain("Check a receipt");
      expect(r.text).toContain("Ed25519");
      expect(r.text).not.toContain("/*LOOK*/");
    }
  });
});
