// Agent identity (src/identity.js, src/routes/identity.js): seats, sponsors, decaying attestation,
// blueprint + lineage freeze, self-quarantine, blast-radius preview.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { req, admin, newTenant, shutdown, dbQuery } from "./harness.js";

afterAll(shutdown);

const verify = (token) => req("GET", "/api/grants/verify", { token });
const child = async (token, sub, caps = ["memory.read", "grant.issue", "grant.read"]) => {
  const r = await req("POST", "/api/grants", { token, body: { sub, caps, ttlSec: 3600 } });
  if (r.status !== 201) throw new Error("child grant failed " + r.status + " " + r.text);
  return r.json;
};
const seat = (tenant, sub, extra = {}) =>
  admin("PUT", "/api/admin/identity/agents", { body: { tenant, sub, sponsor: "dennis", owner: "cog", purpose: "test", ...extra } });
const mode = (m) => admin("POST", "/api/admin/identity/mode", { body: { mode: m } });
const events = async (type, sub) =>
  (await dbQuery("SELECT * FROM events WHERE type = $1 AND actor IS NOT DISTINCT FROM $2", [type, sub])).rows;

describe("identity: modes and the owner's own key", () => {
  let t;
  beforeAll(async () => {
    t = await newTenant("id-modes");
  });

  test("default mode is warn; admin-only; bad mode refused", async () => {
    expect((await req("GET", "/api/admin/identity")).status).toBe(401);
    const s = await admin("GET", "/api/admin/identity");
    expect(s.status).toBe(200);
    expect(s.json.mode).toBe("warn");
    expect((await mode("yolo")).status).toBe(400);
  });

  test("the root grant is never checked, even in enforce", async () => {
    expect((await mode("enforce")).json).toEqual({ mode: "enforce", was: "warn" });
    expect((await verify(t.token)).status).toBe(200);
    const me = await req("GET", "/api/identity/me", { token: t.token });
    expect(me.json.root).toBe(true);
    await mode("warn");
  });

  test("warn: an unseated agent still gets in, logs ONE identity.warn, and shows on the backfill list", async () => {
    const c = await child(t.token, "agent:drifter");
    expect((await verify(c.token)).status).toBe(200);
    expect((await verify(c.token)).status).toBe(200);
    const warns = await events("identity.warn", "agent:drifter");
    expect(warns.length).toBe(1);
    expect(warns[0].data.reason).toBe("unseated");
    const s = await admin("GET", "/api/admin/identity");
    expect(s.json.unseated.some((u) => u.sub === "agent:drifter" && u.tenant === t.id)).toBe(true);
  });

  test("enforce: unseated -> 403 identity_required; seated -> 200; /me names the sponsor", async () => {
    const c = await child(t.token, "agent:newhire");
    await mode("enforce");
    const r = await verify(c.token);
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "identity_required", detail: { reason: "unseated", sub: "agent:newhire" } });
    expect((await admin("PUT", "/api/admin/identity/agents", { body: { tenant: t.id, sub: "agent:newhire" } })).json.error).toBe("sponsor_required");
    const s = await seat(t.id, "agent:newhire");
    expect(s.status).toBe(201);
    expect(s.json.paperwork).toBe("ok");
    expect((await verify(c.token)).status).toBe(200);
    const me = await req("GET", "/api/identity/me", { token: c.token });
    expect(me.json).toMatchObject({ seated: true, sub: "agent:newhire", sponsor: "dennis", owner: "cog", status: "active" });
    expect(typeof me.json.attestDue).toBe("string");
    await mode("warn");
  });
});

describe("identity: decaying attestation and expiry", () => {
  let t, c;
  beforeAll(async () => {
    t = await newTenant("id-attest");
    c = await child(t.token, "agent:sleepy");
    await seat(t.id, "agent:sleepy", { attestEveryDays: 30 });
    await mode("enforce");
  });
  afterAll(() => mode("warn"));

  test("a sponsor who stops re-upping: the seat lapses; attest brings it back", async () => {
    await dbQuery("UPDATE agents SET attested_at = now() - interval '31 days' WHERE sub = 'agent:sleepy'");
    const r = await verify(c.token);
    expect(r.status).toBe(403);
    expect(r.json.detail.reason).toBe("attestation_lapsed");
    expect((await admin("POST", "/api/admin/identity/attest", { body: { tenant: t.id, sub: "agent:sleepy" } })).json.error).toBe("by_required");
    const a = await admin("POST", "/api/admin/identity/attest", { body: { tenant: t.id, sub: "agent:sleepy", by: "drew" } });
    expect(a.json.attested[0].attestedBy).toBe("drew");
    expect((await verify(c.token)).status).toBe(200);
  });

  test("an expired seat stops its keys even though the keys themselves are still live", async () => {
    await dbQuery("UPDATE agents SET expires_at = now() - interval '1 minute' WHERE sub = 'agent:sleepy'");
    expect((await verify(c.token)).json.detail.reason).toBe("agent_expired");
    await dbQuery("UPDATE agents SET expires_at = NULL WHERE sub = 'agent:sleepy'");
  });
});

describe("identity: blueprint freeze, lineage, blast radius", () => {
  let t, worker, sub2, grand;
  beforeAll(async () => {
    t = await newTenant("id-freeze");
    worker = await child(t.token, "agent:cline-1");
    sub2 = await child(t.token, "agent:cline-2");
    await seat(t.id, "agent:cline-1", { blueprint: "cline-worker" });
    await seat(t.id, "agent:cline-2", { blueprint: "cline-worker" });
    // cline-1 delegates to a helper that is NOT in the blueprint
    grand = await child(worker.token, "agent:helper", ["memory.read"]);
    await seat(t.id, "agent:helper");
  });

  test("dry run answers exactly what would stop, and changes nothing", async () => {
    const d = await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, blueprint: "cline-worker", dryRun: true } });
    expect(d.json.dryRun).toBe(true);
    expect(d.json.seats).toEqual(["agent:cline-1", "agent:cline-2"]);
    expect(d.json.liveKeys).toBe(3); // both workers + the helper below cline-1
    expect((await verify(grand.token)).status).toBe(200);
  });

  test("freeze: every agent of the blueprint AND everything they delegated to stops — in warn mode too", async () => {
    expect((await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, blueprint: "cline-worker" } })).json.error).toBe("reason_required");
    const f = await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, blueprint: "cline-worker", reason: "bad push" } });
    expect(f.json.liveKeys).toBe(3);
    for (const k of [worker, sub2]) {
      const r = await verify(k.token);
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("blueprint_frozen");
      expect(r.json.detail.at).toBe("self");
    }
    const g = await verify(grand.token);
    expect(g.json).toEqual({ error: "blueprint_frozen", detail: { blueprint: "cline-worker", sub: "agent:cline-1", at: "above", reason: "bad push" } });
    // the owner is untouched
    expect((await verify(t.token)).status).toBe(200);
    const rcpt = (await dbQuery("SELECT data FROM events WHERE type = 'identity.frozen' AND tenant = $1", [t.id])).rows;
    expect(rcpt[0].data).toMatchObject({ blueprint: "cline-worker", liveKeys: 3 });
  });

  test("re-seating an agent never lifts a freeze; unfreeze does", async () => {
    await seat(t.id, "agent:cline-1", { blueprint: "cline-worker" });
    expect((await verify(worker.token)).status).toBe(403);
    expect((await admin("POST", "/api/admin/identity/unfreeze", { body: { tenant: t.id, blueprint: "cline-worker" } })).status).toBe(200);
    for (const k of [worker, sub2, grand]) expect((await verify(k.token)).status).toBe(200);
    expect((await admin("POST", "/api/admin/identity/unfreeze", { body: { tenant: t.id, blueprint: "cline-worker" } })).json.error).toBe("not_frozen");
  });

  test("one agent can be frozen on its own; an unseated one too", async () => {
    await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, sub: "agent:cline-2", reason: "looping" } });
    expect((await verify(sub2.token)).json.error).toBe("agent_frozen");
    expect((await verify(worker.token)).status).toBe(200);
    const stray = await child(t.token, "agent:stray");
    await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, sub: "agent:stray", reason: "who is this" } });
    expect((await verify(stray.token)).json.error).toBe("agent_frozen");
    expect((await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, sub: "x", blueprint: "y", reason: "r" } })).json.error).toBe(
      "give_sub_or_blueprint",
    );
  });
});

describe("identity: self-quarantine", () => {
  let t, c;
  beforeAll(async () => {
    t = await newTenant("id-quarantine");
    c = await child(t.token, "agent:prober", ["memory.read"]);
    await seat(t.id, "agent:prober");
    await dbQuery("INSERT INTO settings (key, value) VALUES ('identity_strikes', '3') ON CONFLICT (key) DO UPDATE SET value = '3'");
  });

  test("an agent that keeps reaching past its power freezes itself; unfreeze restores it", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await req("POST", "/api/memory", { token: c.token, body: { content: "x" } });
      expect(r.json.error).toBe("missing_cap");
    }
    const q = await verify(c.token);
    expect(q.status).toBe(403);
    expect(q.json.error).toBe("agent_quarantined");
    expect((await events("identity.quarantined", "runtime")).some((e) => e.data.sub === "agent:prober")).toBe(true);
    await admin("POST", "/api/admin/identity/unfreeze", { body: { tenant: t.id, sub: "agent:prober" } });
    expect((await verify(c.token)).status).toBe(200);
  });

  test("the owner's own denied calls never count", async () => {
    const owner = await newTenant("id-quarantine-owner");
    expect((await verify(owner.token)).status).toBe(200);
    const n = (await dbQuery("SELECT count(*)::int AS n FROM agents WHERE tenant = $1", [owner.id])).rows[0].n;
    expect(n).toBe(0);
  });
});
