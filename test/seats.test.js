// Seat mint (src/seats.js, src/routes/seats.js): one call makes a whole seat (tour + seat row +
// SOUL/MEMORY/MATRIX files + receipt), never more than was paid, never twice for one payment,
// and never half: a failure undoes what was done.
//
// Own file, own bun process (test/run.mjs): the harness boots a whole runtime when it is imported.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { req, admin, newTenant, shutdown, dbQuery } from "./harness.js";

afterAll(shutdown);

const mint = (body) => admin("POST", "/api/admin/seats/mint", { body });
const verify = (token) => req("GET", "/api/grants/verify", { token });
const base = (tenant, name, extra = {}) => ({
  tenant,
  name,
  sponsor: "dennis",
  owner: "cog",
  purpose: "answers the phone for a plumber",
  blueprint: "ring-captain",
  days: 3,
  caps: ["memory.read", "memory.write"],
  budget: { usd_cents: 900, calls: 200 },
  payment: { rail: "square", ref: `sq_${name}`, usd_cents: 1000 },
  ...extra,
});

describe("seat mint: the whole seat in one call", () => {
  let t, r;
  beforeAll(async () => {
    t = await newTenant("seats-main", "studio");
    r = await mint(base(t.id, "rc.one"));
  });

  test("admin-only", async () => {
    expect((await req("POST", "/api/admin/seats/mint", { body: base(t.id, "rc.nobody") })).status).toBe(401);
  });

  test("answers 201 with the seat, the tour, a working key and three files", () => {
    expect(r.status).toBe(201);
    expect(r.json.mint.status).toBe("minted");
    expect(r.json.seat).toMatchObject({ sub: "agent:rc.one", blueprint: "ring-captain", sponsor: "dennis", owner: "cog", status: "active" });
    expect(r.json.key.sub).toBe("agent:rc.one");
    expect(typeof r.json.key.token).toBe("string");
    expect(r.json.files.map((f) => f.key).sort()).toEqual(["MATRIX.md", "MEMORY.md", "SOUL.md"]);
    expect(new Set(r.json.files.map((f) => f.partition))).toEqual(new Set(["agent:rc.one:seat"]));
  });

  test("the key works, is seated (paperwork ok), and reads its own files", async () => {
    expect((await verify(r.json.key.token)).status).toBe(200);
    const me = await req("GET", "/api/identity/me", { token: r.json.key.token });
    expect(me.json).toMatchObject({ seated: true, sub: "agent:rc.one", paperwork: "ok" });
    const files = await req("GET", "/api/memory?partition=agent:rc.one:seat&limit=10", { token: r.json.key.token });
    expect(files.status).toBe(200);
  });

  test("MATRIX.md is read off the grant: it names exactly the caps and budget the tour holds", async () => {
    const m = (await dbQuery("SELECT content FROM memories WHERE partition = 'agent:rc.one:seat' AND key = 'MATRIX.md'")).rows[0].content;
    expect(m).toContain("`memory.read`");
    expect(m).toContain("`memory.write`");
    expect(m).not.toContain("`deploy.worker`");
    expect(m).toContain("usd_cents: 900");
    expect(m).toContain("`agent:rc.one:`");
    const soul = (await dbQuery("SELECT content FROM memories WHERE partition = 'agent:rc.one:seat' AND key = 'SOUL.md'")).rows[0].content;
    expect(soul).toContain("answers the phone for a plumber");
  });

  test("the receipt: seat_mints row + seat.minted event", async () => {
    const row = (await dbQuery("SELECT * FROM seat_mints WHERE id = $1", [r.json.mint.id])).rows[0];
    expect(row).toMatchObject({ status: "minted", rail: "square", payment_ref: "sq_rc.one", paid_cents: 1000, agent: "rc.one" });
    const ev = (await dbQuery("SELECT data FROM events WHERE type = 'seat.minted' AND tenant = $1", [t.id])).rows;
    expect(ev.length).toBe(1);
    expect(ev[0].data).toMatchObject({ sub: "agent:rc.one", payment_ref: "sq_rc.one", key: r.json.key.id });
    expect(JSON.stringify(ev[0].data)).not.toContain(r.json.key.token); // the key itself is never on the record
  });

  test("the same payment again: replayed, no second seat, no key", async () => {
    const again = await mint(base(t.id, "rc.one"));
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect(again.json.key).toBeUndefined();
    expect((await dbQuery("SELECT count(*)::int AS n FROM seat_mints WHERE tenant = $1", [t.id])).rows[0].n).toBe(1);
    expect((await dbQuery("SELECT count(*)::int AS n FROM tours WHERE tenant = $1", [t.id])).rows[0].n).toBe(1);
  });

  test("freezing the blueprint stops the minted key (existing off switch)", async () => {
    await admin("POST", "/api/admin/identity/freeze", { body: { tenant: t.id, blueprint: "ring-captain", reason: "test" } });
    expect((await verify(r.json.key.token)).json.error).toBe("blueprint_frozen");
    await admin("POST", "/api/admin/identity/unfreeze", { body: { tenant: t.id, blueprint: "ring-captain" } });
    expect((await verify(r.json.key.token)).status).toBe(200);
  });

  test("the mint list shows it", async () => {
    const l = await admin("GET", `/api/admin/seats/mints?tenant=${t.id}`);
    expect(l.json.mints[0]).toMatchObject({ agent: "rc.one", status: "minted", rail: "square" });
  });
});

describe("seat mint: refusals, all before anything is written", () => {
  let t;
  beforeAll(async () => {
    t = await newTenant("seats-refuse", "studio");
  });
  const nothingWritten = async () => {
    expect((await dbQuery("SELECT count(*)::int AS n FROM seat_mints WHERE tenant = $1", [t.id])).rows[0].n).toBe(0);
    expect((await dbQuery("SELECT count(*)::int AS n FROM agents WHERE tenant = $1", [t.id])).rows[0].n).toBe(0);
    expect((await dbQuery("SELECT count(*)::int AS n FROM tours WHERE tenant = $1", [t.id])).rows[0].n).toBe(0);
  };

  test("a seat never holds more than was paid", async () => {
    const r = await mint(base(t.id, "greedy", { budget: { usd_cents: 1001 } }));
    expect(r.status).toBe(402);
    expect(r.json.error).toBe("budget_exceeds_payment");
    await nothingWritten();
  });

  test("missing pieces answer 400", async () => {
    expect((await mint(base(t.id, "Bad Name"))).json.error).toBe("seat_name_required");
    expect((await mint(base(t.id, "x", { sponsor: "" }))).json.error).toBe("sponsor_required");
    expect((await mint(base(t.id, "x", { caps: [] }))).json.error).toBe("caps_required");
    expect((await mint(base(t.id, "x", { budget: {} }))).json.error).toBe("budget_required");
    expect((await mint(base(t.id, "x", { payment: { rail: "paypal" } }))).json.error).toBe("payment_rail_required");
    expect((await mint(base(t.id, "x", { payment: { rail: "square", usd_cents: 100 } }))).json.error).toBe("payment_ref_required");
    expect((await mint(base(t.id, "x", { soul: "s".repeat(16001) }))).status).toBe(413);
    await nothingWritten();
  });

  test("dry run answers the plan and writes nothing", async () => {
    const r = await mint(base(t.id, "dry.one", { dryRun: true }));
    expect(r.status).toBe(200);
    expect(r.json.dryRun).toBe(true);
    expect(r.json.seat.sub).toBe("agent:dry.one");
    expect(r.json.files.length).toBe(3);
    await nothingWritten();
  });

  test("an existing seat is not minted over", async () => {
    await admin("PUT", "/api/admin/identity/agents", { body: { tenant: t.id, sub: "agent:taken", sponsor: "dennis" } });
    const r = await mint(base(t.id, "taken"));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("seat_exists");
    await dbQuery("DELETE FROM agents WHERE tenant = $1", [t.id]);
  });

  test("house seats need no payment ref", async () => {
    const r = await mint(base(t.id, "house.one", { payment: { rail: "house" } }));
    expect(r.status).toBe(201);
    expect(r.json.mint.rail).toBe("house");
  });
});

describe("seat mint: never half a seat", () => {
  let t;
  beforeAll(async () => {
    t = await newTenant("seats-undo", "studio");
  });

  test("a tour the tier cannot hold fails cleanly; the claim is marked failed and can be retried", async () => {
    const r = await mint(base(t.id, "toolong", { days: 30 }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    const row = (await dbQuery("SELECT * FROM seat_mints WHERE tenant = $1", [t.id])).rows[0];
    expect(row.status).toBe("failed");
    expect((await dbQuery("SELECT count(*)::int AS n FROM agents WHERE tenant = $1", [t.id])).rows[0].n).toBe(0);
    const retry = await mint(base(t.id, "toolong", { days: 2 }));
    expect(retry.status).toBe(201);
    expect((await dbQuery("SELECT count(*)::int AS n FROM seat_mints WHERE tenant = $1", [t.id])).rows[0].n).toBe(1);
  });

  test("a failure after the tour opened ends the tour and removes the seat row", async () => {
    // the files step fails: make the memories table refuse this seat's section
    await dbQuery(`CREATE OR REPLACE FUNCTION seat_test_refuse() RETURNS trigger AS $$ BEGIN
      IF NEW.partition = 'agent:breaks:seat' AND NEW.key = 'MATRIX.md' THEN RAISE EXCEPTION 'refused by test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await dbQuery("CREATE TRIGGER seat_test_refuse BEFORE INSERT ON memories FOR EACH ROW EXECUTE FUNCTION seat_test_refuse()");
    try {
      const r = await mint(base(t.id, "breaks"));
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect((await dbQuery("SELECT status FROM seat_mints WHERE agent = 'breaks'")).rows[0].status).toBe("failed");
      expect((await dbQuery("SELECT count(*)::int AS n FROM agents WHERE sub = 'agent:breaks'")).rows[0].n).toBe(0);
      expect((await dbQuery("SELECT status FROM tours WHERE agent = 'breaks'")).rows[0].status).toBe("ended");
      const live = await dbQuery("SELECT count(*)::int AS n FROM memories WHERE partition = 'agent:breaks:seat' AND deleted = false");
      expect(live.rows[0].n).toBe(0);
      expect((await dbQuery("SELECT count(*)::int AS n FROM events WHERE type = 'seat.mint_failed' AND tenant = $1 AND data->>'sub' = 'agent:breaks'", [t.id])).rows[0].n).toBe(1);
    } finally {
      await dbQuery("DROP TRIGGER seat_test_refuse ON memories");
    }
  });
});
