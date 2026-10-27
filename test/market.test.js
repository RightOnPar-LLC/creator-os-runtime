// Market call (src/market.js, src/routes/market.js): the same door as POST /api/escrow.
// Pinned after a live test (2026-10-27) found POST /api/market/call opening a real escrow for a grant at
// autonomy "ask" with no approval, paying whoever the caller named, for any amount, for a capability that
// was never listed, and answering with the raw grant row beside the token.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported, and
// runtime.test.js already holds that boot.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { req, admin, newTenant, shutdown, dbQuery } from "./harness.js";

afterAll(shutdown);

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

describe("market: call = open an escrow on the listing's terms, through the autonomy dial", () => {
  let provider, caller, cap, price;
  const PRICE = 5;

  // a key under the caller's root, at a chosen dial setting
  const key = async (autonomy) => {
    const r = await req("POST", "/api/grants", {
      token: caller.token,
      body: {
        sub: "agent:buyer-" + autonomy,
        caps: ["escrow.hold", "grant.read"],
        ttlSec: 600,
        budget: { usd_cents: 500, calls: 5, deploys: 0 },
        constraints: { autonomy },
      },
    });
    expect(r.status).toBe(201);
    return r.json.token;
  };
  const left = async (token) => (await req("GET", "/api/grants/verify", { token })).json.remaining.usd_cents;
  const approvals = async () => (await req("GET", "/api/approvals", { token: caller.token })).json.approvals;
  const holds = async () => (await dbQuery("SELECT count(*)::int AS n FROM grants WHERE tenant = $1 AND sub LIKE 'escrow:%'", [caller.id])).rows[0].n;
  const call = (token, body) => req("POST", "/api/market/call", { token, body });

  beforeAll(async () => {
    provider = await newTenant("market-provider", "studio");
    caller = await newTenant("market-caller", "studio");
    const listed = await req("POST", "/api/market/list", { token: provider.token, body: { name: "echo", price: PRICE, description: "test listing" } });
    expect(listed.status).toBe(201);
    cap = listed.json.id;
    price = listed.json.price;
    expect(price).toBe(PRICE);
  });

  test("discover is public and names who would be paid", async () => {
    const r = await req("GET", "/api/market/discover");
    expect(r.status).toBe(200);
    const mine = r.json.capabilities.find((c) => c.capability_id === cap);
    expect(mine).toBeTruthy();
    expect(mine.price).toBe(PRICE);
    expect(mine.provider_tenant).toBe(provider.id);
  });

  test("at autonomy ask: 202 awaiting approval, NOTHING held, and the approval carries the listing's terms (not the caller's)", async () => {
    const k = await key("ask");
    const before = await left(k);
    const heldBefore = await holds();
    // the caller names a different payee and a different amount: both are only checked against the listing,
    // so naming the real ones is accepted and the filed terms are the listing's
    const r = await call(k, { capability_id: cap, provider_tenant: provider.id, amount: PRICE });
    expect(r.status).toBe(202);
    expect(r.json.status).toBe("awaiting_approval");
    expect(r.json.escrow).toBeUndefined(); // no hold was opened
    expect(await left(k)).toBe(before); // nothing reserved on the key
    expect(await holds()).toBe(heldBefore); // and no custodian grant exists
    const filed = (await approvals()).find((a) => a.id === r.json.approval.id);
    expect(filed.action).toBe("escrow.open");
    expect(filed.status).toBe("pending");
    const intent = parse(filed.intent);
    expect(intent.payee_tenant).toBe(provider.id);
    expect(intent.amount).toBe(PRICE);
    expect(intent.payee_ref).toBe(cap);
    expect(intent.condition.kind).toBe("attestation:self-settle");
  });

  test("the owner approves: the hold opens on exactly those terms and the key's budget drops by the price", async () => {
    const k = await key("ask");
    const before = await left(k);
    const d = await call(k, { capability_id: cap });
    expect(d.status).toBe(202);
    // only the owner's own (root) key may approve
    const ok = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: caller.token, body: { decision: "approve" } });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("executed");
    expect(ok.json.result.escrow.state).toBe("open");
    expect(ok.json.result.escrow.amount).toBe(PRICE);
    expect(ok.json.result.escrow.payee_tenant).toBe(provider.id);
    expect(ok.json.result.escrow.payee_ref).toBe(cap);
    expect(await left(k)).toBe(before - PRICE);
  });

  test("CONTROL: denying leaves nothing held", async () => {
    const k = await key("ask");
    const before = await left(k);
    const d = await call(k, { capability_id: cap });
    expect(d.status).toBe(202);
    const no = await req("POST", `/api/approvals/${d.json.approval.id}`, { token: caller.token, body: { decision: "deny" } });
    expect(no.status).toBe(200);
    expect(no.json.status).toBe("denied");
    expect(await left(k)).toBe(before);
  });

  test("at autonomy observe: refused 403, nothing held, nothing filed", async () => {
    const k = await key("observe");
    const before = await left(k);
    const filed = (await approvals()).length;
    const r = await call(k, { capability_id: cap });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("autonomy_observe_only");
    expect(await left(k)).toBe(before);
    expect((await approvals()).length).toBe(filed);
  });

  test("at autonomy act (the owner's own key): 201, and the answer is the cleaned-up escrow, never the raw grant row", async () => {
    const r = await call(caller.token, { capability_id: cap });
    expect(r.status).toBe(201);
    expect(r.json.escrow.state).toBe("open");
    expect(r.json.escrow.amount).toBe(PRICE);
    expect(r.json.escrow.payee_tenant).toBe(provider.id);
    expect(r.json.escrow.id).toMatch(/^es_/);
    expect(typeof r.json.token).toBe("string");
    // the raw row (with its signed payload) must not travel
    expect(r.json.escrow.row).toBeUndefined();
    expect(r.json.escrow.payload).toBeUndefined();
    expect(r.text).not.toContain('"payload"');
  });

  test("a capability that was never listed is 404, and nothing is held or filed", async () => {
    const k = await key("ask");
    const before = await left(k);
    const filed = (await approvals()).length;
    const heldBefore = await holds();
    for (const k2 of [k, caller.token]) {
      const r = await call(k2, { capability_id: "cap_does_not_exist" });
      expect(r.status).toBe(404);
      expect(r.json.error).toBe("capability_not_found");
    }
    expect((await call(k, {})).status).toBe(400); // no capability named at all
    expect(await left(k)).toBe(before);
    expect((await approvals()).length).toBe(filed);
    expect(await holds()).toBe(heldBefore);
  });

  test("an amount or a payee that disagrees with the listing is refused, never obeyed", async () => {
    const k = await key("ask");
    const filed = (await approvals()).length;
    const heldBefore = await holds();
    const high = await call(k, { capability_id: cap, amount: 45 });
    expect([high.status, high.json.error]).toEqual([400, "amount_mismatch"]);
    expect(high.json.detail.price).toBe(PRICE);
    const other = await call(k, { capability_id: cap, provider_tenant: caller.id });
    expect([other.status, other.json.error]).toEqual([400, "provider_mismatch"]);
    expect(other.json.detail.provider_tenant).toBe(provider.id);
    expect((await approvals()).length).toBe(filed);
    expect(await holds()).toBe(heldBefore);
  });

  test("a tenant cannot buy its own listing", async () => {
    const r = await call(provider.token, { capability_id: cap });
    expect([r.status, r.json.error]).toEqual([400, "cannot_buy_own_listing"]);
  });

  test("the key must hold escrow.hold: a key without it is refused at the door", async () => {
    const nokey = await req("POST", "/api/grants", {
      token: caller.token,
      body: { sub: "agent:no-hold", caps: ["grant.read"], ttlSec: 600, budget: { usd_cents: 100, calls: 5, deploys: 0 } },
    });
    expect(nokey.status).toBe(201);
    const r = await call(nokey.json.token, { capability_id: cap });
    expect(r.status).toBe(403);
  });

  test("admin sees the whole trail on the ledger: a refused or pending call leaves no value movement", async () => {
    const ledger = (await admin("GET", "/api/admin/ledger")).json.ledger;
    expect(ledger.filter((l) => l.kind === "escrow-capture" && l.tenant === caller.id).length).toBe(0);
  });
});
