// Routes: agent identity — seats, sponsors, blueprints, freezes (identity.js holds the rules).
//
//   GET  /api/admin/identity           mode, seats, blueprints, and the live agent keys with NO seat (the backfill list)
//   POST /api/admin/identity/mode      {mode: off|warn|enforce}
//   PUT  /api/admin/identity/agents    seat an agent: {tenant, sub, sponsor, owner?, purpose?, blueprint?, attestEveryDays?, expiresAt?}
//   POST /api/admin/identity/attest    the sponsor re-ups: {tenant, sub | blueprint, by}
//   POST /api/admin/identity/freeze    {tenant, sub | blueprint, reason, dryRun?} — answers the blast radius either way
//   POST /api/admin/identity/unfreeze  {tenant, sub | blueprint}
//   GET  /api/identity/me              an agent reads its own seat: who sponsors it, who owns it, when it lapses
//
// Re-seating an agent never lifts a freeze; only unfreeze does. Every change writes an identity.* event.
import { HttpError } from "../util.js";
import { getTenant, recordEvent, sql } from "../db.js";
import { blastRadius, identityMode, paperworkProblem, setIdentityMode, strikeLimit, unseatedAgents, upsertSeat } from "../identity.js";
import { app, readJsonBody, requireAdmin, requireGrant } from "../http.js";

var BLUEPRINT_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
var text = (v, max) => (v == null || v === "" ? null : String(v).slice(0, max));

async function tenantOf(b) {
  let t = await getTenant(String(b?.tenant || ""));
  if (!t) throw new HttpError(404, "tenant_not_found");
  return t;
}
function subOf(b, required = true) {
  let s = text(b?.sub, 120);
  if (!s && required) throw new HttpError(400, "sub_required");
  return s;
}
function blueprintOf(b) {
  if (b?.blueprint == null || b.blueprint === "") return null;
  let id = String(b.blueprint);
  if (!BLUEPRINT_ID.test(id)) throw new HttpError(400, "bad_blueprint", { pattern: String(BLUEPRINT_ID) });
  return id;
}
// Exactly one of sub / blueprint names the target of attest / freeze / unfreeze.
function targetOf(b) {
  let sub = subOf(b, false),
    blueprint = blueprintOf(b);
  if (!!sub === !!blueprint) throw new HttpError(400, "give_sub_or_blueprint");
  return { sub, blueprint };
}
async function subsInBlueprint(tenant, blueprint) {
  return (await sql`SELECT sub FROM agents WHERE tenant = ${tenant} AND blueprint = ${blueprint} ORDER BY sub`).map((r) => r.sub);
}
export var seatView = (a) => ({
  tenant: a.tenant,
  sub: a.sub,
  blueprint: a.blueprint,
  sponsor: a.sponsor,
  owner: a.owner,
  purpose: a.purpose,
  status: a.status,
  frozenReason: a.frozen_reason || void 0,
  attestedAt: a.attested_at,
  attestedBy: a.attested_by,
  attestEveryDays: Number(a.attest_every_days),
  attestDue: a.attested_at && Number(a.attest_every_days) > 0 ? new Date(new Date(a.attested_at).getTime() + Number(a.attest_every_days) * 86400000).toISOString() : null,
  expiresAt: a.expires_at,
  paperwork: paperworkProblem({ ...a, seat: a.sub }) || "ok",
});

app.get("/api/admin/identity", requireAdmin, async (e) => {
  let [agents, blueprints, unseated] = await Promise.all([
    sql`SELECT * FROM agents ORDER BY tenant, blueprint NULLS LAST, sub LIMIT 500`,
    sql`SELECT b.*, (SELECT count(*)::int FROM agents a WHERE a.tenant = b.tenant AND a.blueprint = b.id) AS seats FROM blueprints b ORDER BY tenant, id`,
    unseatedAgents(),
  ]);
  return e.json({
    mode: await identityMode(),
    strikeLimit: await strikeLimit(),
    agents: agents.map(seatView),
    blueprints: blueprints.map((b) => ({ tenant: b.tenant, id: b.id, purpose: b.purpose, status: b.status, frozenReason: b.frozen_reason || void 0, seats: b.seats })),
    unseated: unseated.map((u) => ({ tenant: u.tenant, sub: u.sub, liveKeys: u.live_keys })),
  });
});

app.post("/api/admin/identity/mode", requireAdmin, async (e) => {
  let b = await readJsonBody(e),
    from = await identityMode(),
    to = await setIdentityMode(String(b?.mode || ""));
  await recordEvent("identity.mode", { from, to }, null, "admin");
  return e.json({ mode: to, was: from });
});

app.put("/api/admin/identity/agents", requireAdmin, async (e) => {
  let b = await readJsonBody(e),
    t = await tenantOf(b),
    sub = subOf(b),
    sponsor = text(b.sponsor, 120);
  if (!sponsor) throw new HttpError(400, "sponsor_required", { hint: "the human accountable for why this agent exists" });
  let row = await upsertSeat(t.id, sub, { ...b, sponsor, blueprint: blueprintOf(b) });
  await recordEvent(row.created ? "identity.seated" : "identity.reseated", { sub, blueprint: row.blueprint, sponsor, owner: row.owner }, t.id, "admin");
  return e.json(seatView(row), row.created ? 201 : 200);
});

app.post("/api/admin/identity/attest", requireAdmin, async (e) => {
  let b = await readJsonBody(e),
    t = await tenantOf(b),
    { sub, blueprint } = targetOf(b),
    by = text(b.by, 120);
  if (!by) throw new HttpError(400, "by_required", { hint: "who is re-upping this seat" });
  let rows = sub
    ? await sql`UPDATE agents SET attested_at = now(), attested_by = ${by}, updated_at = now() WHERE tenant = ${t.id} AND sub = ${sub} RETURNING *`
    : await sql`UPDATE agents SET attested_at = now(), attested_by = ${by}, updated_at = now() WHERE tenant = ${t.id} AND blueprint = ${blueprint} RETURNING *`;
  if (!rows.length) throw new HttpError(404, "no_seat");
  await recordEvent("identity.attested", { sub, blueprint, by, seats: rows.length }, t.id, "admin");
  return e.json({ attested: rows.map(seatView) });
});

app.post("/api/admin/identity/freeze", requireAdmin, async (e) => {
  let b = await readJsonBody(e),
    t = await tenantOf(b),
    { sub, blueprint } = targetOf(b),
    reason = text(b.reason, 300),
    subs = sub ? [sub] : await subsInBlueprint(t.id, blueprint),
    radius = await blastRadius(t.id, subs);
  if (b.dryRun) return e.json({ dryRun: true, target: sub ? { sub } : { blueprint }, ...radius });
  if (!reason) throw new HttpError(400, "reason_required");
  if (sub)
    // An unseated agent can be frozen too: its row is made frozen, with no sponsor, until someone seats it.
    await sql`INSERT INTO agents (tenant, sub, status, frozen_reason, frozen_by, frozen_at) VALUES (${t.id}, ${sub}, 'frozen', ${reason}, 'admin', now())
      ON CONFLICT (tenant, sub) DO UPDATE SET status = 'frozen', frozen_reason = EXCLUDED.frozen_reason, frozen_by = 'admin', frozen_at = now(), updated_at = now()`;
  else
    await sql`INSERT INTO blueprints (tenant, id, status, frozen_reason, frozen_by, frozen_at) VALUES (${t.id}, ${blueprint}, 'frozen', ${reason}, 'admin', now())
      ON CONFLICT (tenant, id) DO UPDATE SET status = 'frozen', frozen_reason = EXCLUDED.frozen_reason, frozen_by = 'admin', frozen_at = now(), updated_at = now()`;
  // The receipt: what was stopped, in numbers, at the moment it was stopped.
  await recordEvent("identity.frozen", { sub, blueprint, reason, seats: radius.seats, liveKeys: radius.liveKeys }, t.id, "admin");
  return e.json({ frozen: sub ? { sub } : { blueprint }, reason, ...radius });
});

app.post("/api/admin/identity/unfreeze", requireAdmin, async (e) => {
  let b = await readJsonBody(e),
    t = await tenantOf(b),
    { sub, blueprint } = targetOf(b);
  let rows = sub
    ? await sql`UPDATE agents SET status = 'active', frozen_reason = NULL, frozen_by = NULL, frozen_at = NULL, strikes = 0, updated_at = now()
        WHERE tenant = ${t.id} AND sub = ${sub} AND status IN ('frozen', 'quarantined') RETURNING sub`
    : await sql`UPDATE blueprints SET status = 'active', frozen_reason = NULL, frozen_by = NULL, frozen_at = NULL, updated_at = now()
        WHERE tenant = ${t.id} AND id = ${blueprint} AND status = 'frozen' RETURNING id`;
  if (!rows.length) throw new HttpError(404, "not_frozen");
  await recordEvent("identity.unfrozen", { sub, blueprint }, t.id, "admin");
  return e.json({ unfrozen: sub ? { sub } : { blueprint } });
});

app.get("/api/identity/me", requireGrant(), async (e) => {
  let auth = e.get("auth"),
    g = auth.row;
  if (Number(g.depth) === 0) return e.json({ sub: g.sub, root: true, note: "the tenant owner's own credential; it has no seat" });
  let a = (await sql`SELECT * FROM agents WHERE tenant = ${g.tenant} AND sub = ${g.sub}`)[0];
  if (!a) return e.json({ sub: g.sub, seated: false, paperwork: "unseated", mode: await identityMode() });
  return e.json({ seated: true, mode: await identityMode(), ...seatView(a) });
});
