// OIDC issuer for agent seats (src/oidc.js, src/routes/oidc.js): discovery, JWKS, and
// ID-token minting gated on the same seat paperwork identity.js already enforces.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll } from "bun:test";
import { webcrypto } from "node:crypto";
import { req, admin, newTenant, shutdown } from "./harness.js";

afterAll(shutdown);

const b64uToBytes = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const seat = (tenant, sub, extra = {}) =>
  admin("PUT", "/api/admin/identity/agents", { body: { tenant, sub, sponsor: "dennis", owner: "cog", purpose: "test", ...extra } });

async function verifyJwt(token, jwk) {
  const [h, p, s] = token.split(".");
  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64uToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  return { ok, header: JSON.parse(new TextDecoder().decode(b64uToBytes(h))), payload: JSON.parse(new TextDecoder().decode(b64uToBytes(p))) };
}

describe("oidc: discovery + jwks are public", () => {
  test("discovery doc shape", async () => {
    const r = await req("GET", "/.well-known/openid-configuration");
    expect(r.status).toBe(200);
    expect(r.json.jwks_uri).toBe(r.json.issuer + "/.well-known/jwks.json");
    expect(r.json.id_token_signing_alg_values_supported).toEqual(["ES256"]);
  });

  test("jwks: one ES256 public key, no auth required", async () => {
    const r = await req("GET", "/.well-known/jwks.json");
    expect(r.status).toBe(200);
    expect(r.json.keys.length).toBe(1);
    const k = r.json.keys[0];
    expect(k.kty).toBe("EC");
    expect(k.crv).toBe("P-256");
    expect(k.alg).toBe("ES256");
    expect(k.d).toBeUndefined(); // never the private half
  });
});

describe("oidc: minting is gated on seat paperwork, same as the grant door", () => {
  let t, jwk;
  test("setup: tenant + jwks", async () => {
    t = await newTenant("oidc-seats");
    jwk = (await req("GET", "/.well-known/jwks.json")).json.keys[0];
  });

  test("admin-only", async () => {
    const r = await req("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:x", aud: "tailscale-client-id" } });
    expect(r.status).toBe(401);
  });

  test("unseated agent is refused (identity_required), same reason code the grant door uses", async () => {
    const r = await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:unseated", aud: "tailscale-client-id" } });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "identity_required", detail: { reason: "unseated", sub: "agent:unseated" } });
  });

  test("seated agent: mints a token that verifies against the published JWKS", async () => {
    await seat(t.id, "agent:tailnet-seat");
    const r = await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:tailnet-seat", aud: "tailscale-client-id", ttlSec: 60 } });
    expect(r.status).toBe(200);
    expect(r.json.token_type).toBe("id_token");
    const { ok, header, payload } = await verifyJwt(r.json.id_token, jwk);
    expect(ok).toBe(true);
    expect(header.alg).toBe("ES256");
    expect(payload.sub).toBe(`${t.id}/agent:tailnet-seat`);
    expect(payload.aud).toBe("tailscale-client-id");
    expect(payload.exp - payload.iat).toBe(60);
    expect(payload.exp).toBe(r.json.exp);
  });

  test("ttl is clamped to the max (15 min), never honors a longer ask", async () => {
    const r = await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:tailnet-seat", aud: "tailscale-client-id", ttlSec: 999999 } });
    expect(r.status).toBe(200);
    const { payload } = await verifyJwt(r.json.id_token, jwk);
    expect(payload.exp - payload.iat).toBe(900);
  });

  test("a tampered token fails verification", async () => {
    const r = await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:tailnet-seat", aud: "tailscale-client-id" } });
    const [h, p, s] = r.json.id_token.split(".");
    const forged = JSON.stringify({ ...JSON.parse(new TextDecoder().decode(b64uToBytes(p))), sub: `${t.id}/agent:someone-else` });
    const forgedP = Buffer.from(forged).toString("base64url");
    const { ok } = await verifyJwt(`${h}.${forgedP}.${s}`, jwk);
    expect(ok).toBe(false);
  });

  test("freezing the seat immediately blocks minting (lineage-freeze rule reused from identity.js)", async () => {
    await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, sub: "agent:tailnet-seat", reason: "test freeze" } });
    const r = await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:tailnet-seat", aud: "tailscale-client-id" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("agent_frozen");
  });

  test("missing fields -> 400s", async () => {
    expect((await admin("POST", "/api/admin/identity/oidc-token", { body: { sub: "agent:x", aud: "a" } })).status).toBe(400);
    expect((await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, aud: "a" } })).status).toBe(400);
    expect((await admin("POST", "/api/admin/identity/oidc-token", { body: { tenant: t.id, sub: "agent:x" } })).status).toBe(400);
  });
});
