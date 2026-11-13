// Seat mint: ONE call that turns "a seat was paid for" into "an agent that exists, may do
// exactly these things, and answers to a human". Nothing here is a new engine. It only puts
// the existing ones in order, so a seat can never be half made:
//
//   1. claim the payment     seat_mints row; the same (rail, payment ref) can never mint twice,
//                            so a webhook retried ten times still makes one seat
//   2. open a tour           tours.js: a fresh 24-hour key, renewed until the seat's end date,
//                            inside a budget set once (never more than was paid). No long-lived key.
//   3. seat the agent        identity.js upsertSeat: sponsor, owner, blueprint, attestation. The
//                            same row the freeze switches and (once merged) the OIDC issuer read.
//   4. write three files     memory, in the agent's own section agent:<name>:seat
//                              SOUL.md    who it is (given by the minter, or a starter)
//                              MEMORY.md  its own memory, empty to start
//                              MATRIX.md  what it may do: GENERATED from the tour's own grant, so
//                                         it can never say more (or less) than the grant allows
//   5. receipt               seat_mints row -> 'minted' + a seat.minted event (rides the outbox)
//
// If any step after the claim fails, the steps before it are undone in reverse (tour ended,
// seat row removed, files forgotten) and the claim is marked 'failed' so the same payment can
// be retried. A dry run validates everything and writes nothing.
//
// Off switches are the existing ones: freeze the seat (or its blueprint) in identity.js and the
// tour's key stops at the door at once; end the tour and its budget goes back.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, getTenant, recordEvent, sql } from "./db.js";
import { endTour, openTour } from "./tours.js";
import { upsertSeat } from "./identity.js";
import { forgetMemory, writeMemory } from "./memory.js";
import { normalizeUsage } from "./policy.js";

// The same name rule a tour uses (tours.js AGENT_RE): the seat's key subject is agent:<name>.
var NAME_RE = /^[a-z0-9][a-z0-9.]{0,39}$/;
var BLUEPRINT_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
// Where a payment came from. "house" = the owner seats an agent with no outside payment.
export var SEAT_RAILS = ["square", "x402", "moonpay", "stripe", "house"];
var SOUL_MAX = 16000;
var ACTOR = "runtime:seat-mint";

var plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
var text = (v, max) => (v == null || v === "" ? null : String(v).slice(0, max));
export var seatPartition = (name) => `agent:${name}:seat`;

// The tenant's live owner key: what the tour is opened with.
async function rootAuth(tenantId) {
  let tenant = await getTenant(tenantId);
  if (!tenant) throw new HttpError(404, "tenant_not_found");
  if (tenant.status !== "active") throw new HttpError(403, "tenant_suspended");
  let row = (
    await sql`SELECT * FROM grants WHERE tenant = ${tenantId} AND depth = 0 AND status = 'active' AND exp > ${nowSec()}
      ORDER BY iat DESC LIMIT 1`
  )[0];
  if (!row) throw new HttpError(409, "no_owner_key", { hint: "the tenant has no live root grant to open the seat's tour with" });
  return { row, tenant };
}

// Everything is checked here, before anything is written.
export async function planMint(body) {
  let b = plain(body),
    name = typeof b.name === "string" ? b.name : "";
  if (!NAME_RE.test(name)) throw new HttpError(400, "seat_name_required", { hint: "lowercase letters, digits and dots, 1 to 40 characters" });
  let sponsor = text(b.sponsor, 120);
  if (!sponsor) throw new HttpError(400, "sponsor_required", { hint: "the human accountable for why this seat exists" });
  let blueprint = b.blueprint == null || b.blueprint === "" ? null : String(b.blueprint);
  if (blueprint && !BLUEPRINT_RE.test(blueprint)) throw new HttpError(400, "bad_blueprint", { pattern: String(BLUEPRINT_RE) });
  if (!Array.isArray(b.caps) || !b.caps.length || !b.caps.every((c) => typeof c === "string")) throw new HttpError(400, "caps_required");
  if (!Number.isInteger(b.days)) throw new HttpError(400, "days_required");
  let budget = normalizeUsage(plain(b.budget));
  if (!(budget.usd_cents > 0 || budget.calls > 0 || budget.deploys > 0)) throw new HttpError(400, "budget_required");
  if (b.soul != null && typeof b.soul !== "string") throw new HttpError(400, "bad_soul");
  if (typeof b.soul === "string" && b.soul.length > SOUL_MAX) throw new HttpError(413, "soul_too_long", { max: SOUL_MAX });
  // The money rule: a seat never holds more than was paid for it.
  let p = plain(b.payment),
    rail = text(p.rail, 20),
    ref = text(p.ref, 200),
    paidCents = p.usd_cents == null ? null : Number(p.usd_cents);
  if (!rail || !SEAT_RAILS.includes(rail)) throw new HttpError(400, "payment_rail_required", { rails: SEAT_RAILS });
  if (rail !== "house") {
    if (!ref) throw new HttpError(400, "payment_ref_required", { hint: "the payment's own id on its rail; it is what stops a double mint" });
    if (!Number.isInteger(paidCents) || paidCents < 1) throw new HttpError(400, "payment_amount_required");
    if (budget.usd_cents > paidCents) throw new HttpError(402, "budget_exceeds_payment", { paid_cents: paidCents, budget_cents: budget.usd_cents });
  }
  let auth = await rootAuth(String(b.tenant || "")),
    sub = `agent:${name}`;
  return {
    auth,
    name,
    sub,
    seat: { sponsor, owner: b.owner, purpose: b.purpose, blueprint, attestEveryDays: b.attestEveryDays, expiresAt: b.expiresAt },
    tour: { agent: name, days: b.days, caps: [...new Set(b.caps)], budget, scope: plain(b.scope), constraints: plain(b.constraints) },
    soul: typeof b.soul === "string" && b.soul.trim() ? b.soul : null,
    payment: { rail, ref, paidCents },
  };
}

export function starterSoul(plan) {
  let s = plan.seat;
  return [
    `# SOUL — ${plan.name}`,
    "",
    `I am ${plan.name}, an agent seated on the Mesh${s.blueprint ? ` (blueprint: ${s.blueprint})` : ""}.`,
    s.purpose ? `My purpose: ${String(s.purpose).slice(0, 500)}` : "My purpose has not been written yet; my sponsor will write it.",
    `My sponsor is ${s.sponsor}${s.owner ? ` and ${s.owner} keeps me running` : ""}.`,
    "",
    "I work inside MATRIX.md and nowhere else. When something needs a human, I ask; I never guess past a gate.",
  ].join("\n");
}

export function starterMemory(plan) {
  return [`# MEMORY — ${plan.name}`, "", "Nothing yet. What I learn while I work goes here, in my own section."].join("\n");
}

// MATRIX.md is read off the tour's holding grant, never typed: the file and the power cannot drift apart.
export function matrixFrom(plan, hold, tour) {
  let caps = parseJson(hold.caps),
    budget = normalizeUsage(parseJson(hold.budget)),
    scope = parseJson(hold.scope),
    s = plan.seat;
  return [
    `# MATRIX — ${plan.name}`,
    "",
    "_Generated by the runtime from this seat's grant at mint time. The grant is the truth; this is its reading._",
    "",
    "## Who",
    `- seat: \`${plan.sub}\``,
    `- sponsor: ${s.sponsor}${s.owner ? ` · owner: ${s.owner}` : ""}${s.blueprint ? ` · blueprint: \`${s.blueprint}\`` : ""}`,
    "",
    "## May do",
    ...caps.map((c) => `- \`${c}\``),
    "",
    "## Budget (the whole stay; time never refills it)",
    `- usd_cents: ${budget.usd_cents} · calls: ${budget.calls} · deploys: ${budget.deploys}`,
    "",
    "## Reach",
    `- memory: ${(scope.memory?.partitions || []).map((p) => `\`${p}\``).join(", ") || "none"}`,
    ...(scope.workers?.namePrefix ? [`- workers named: \`${scope.workers.namePrefix}*\``] : []),
    ...(scope.railway?.projects?.length ? [`- railway projects: ${scope.railway.projects.map((p) => `\`${p}\``).join(", ")}`] : []),
    "",
    "## Time",
    `- keys: 24 hours each, renewed with the current key (tour \`${tour.id}\`)`,
    `- seat ends: ${new Date(Number(tour.until) * 1000).toISOString()}`,
    "",
    "## Off switch",
    "- freeze this seat or its blueprint: every key stops at once, and every key it handed on",
  ].join("\n");
}

// Same payment, same answer: the claim row is what makes a retried webhook safe.
async function claim(plan) {
  let { auth, name, payment } = plan,
    id = newId("sm");
  if (payment.ref) {
    let prior = (await sql`SELECT * FROM seat_mints WHERE tenant = ${auth.tenant.id} AND rail = ${payment.rail} AND payment_ref = ${payment.ref}`)[0];
    if (prior && prior.status !== "failed") return { replay: prior };
    if (prior) {
      // a failed mint of this payment may be tried again; only one retry wins the row
      let again = await sql`UPDATE seat_mints SET status = 'minting', agent = ${name}, error = NULL, updated_at = now()
        WHERE id = ${prior.id} AND status = 'failed' RETURNING *`;
      if (!again.length) return { replay: (await sql`SELECT * FROM seat_mints WHERE id = ${prior.id}`)[0] };
      return { row: again[0] };
    }
  }
  try {
    let [row] = await sql`INSERT INTO seat_mints (id, tenant, agent, rail, payment_ref, paid_cents, status)
      VALUES (${id}, ${auth.tenant.id}, ${name}, ${payment.rail}, ${payment.ref}, ${payment.paidCents}, 'minting') RETURNING *`;
    return { row };
  } catch (err) {
    // two mints of one payment at the same moment: the unique index lets one in
    if (/duplicate key|unique constraint/i.test(String(err?.message || "")) || String(err?.errno ?? err?.code ?? "") === "23505")
      return { replay: (await sql`SELECT * FROM seat_mints WHERE tenant = ${auth.tenant.id} AND rail = ${payment.rail} AND payment_ref = ${payment.ref}`)[0] };
    throw err;
  }
}

var mintView = (m) => ({
  id: m.id,
  tenant: m.tenant,
  agent: m.agent,
  status: m.status,
  rail: m.rail,
  paymentRef: m.payment_ref,
  paidCents: m.paid_cents == null ? null : Number(m.paid_cents),
  tour: m.tour_id,
  error: m.error || void 0,
  createdAt: m.created_at,
});

// A payment that already made (or is making) a seat. Looked at before anything else about the seat,
// so a retried webhook gets the same answer even though its seat now exists.
async function priorMint(plan) {
  if (!plan.payment.ref) return null;
  let prior = (await sql`SELECT * FROM seat_mints WHERE tenant = ${plan.auth.tenant.id} AND rail = ${plan.payment.rail} AND payment_ref = ${plan.payment.ref}`)[0];
  return prior && prior.status !== "failed" ? prior : null;
}
var replayed = (m) => ({ status: 200, body: { replayed: true, mint: mintView(m), hint: "this payment already made a seat; the key is shown once, at mint (reissue the tour for a new one)" } });

export async function mintSeat(body) {
  let plan = await planMint(body),
    soul = plan.soul || starterSoul(plan),
    prior = await priorMint(plan);
  if (prior) return replayed(prior);
  if ((await sql`SELECT 1 FROM agents WHERE tenant = ${plan.auth.tenant.id} AND sub = ${plan.sub}`).length)
    throw new HttpError(409, "seat_exists", { sub: plan.sub, hint: "a mint makes a NEW seat; re-seat an existing one with PUT /api/admin/identity/agents" });
  if (plain(body).dryRun)
    return {
      status: 200,
      body: {
        dryRun: true,
        seat: { tenant: plan.auth.tenant.id, sub: plan.sub, ...plan.seat },
        tour: { agent: plan.name, days: plan.tour.days, caps: plan.tour.caps, budget: plan.tour.budget },
        files: ["SOUL.md", "MEMORY.md", "MATRIX.md"].map((k) => ({ partition: seatPartition(plan.name), key: k })),
        soulPreview: soul.slice(0, 400),
      },
    };
  let c = await claim(plan);
  if (c.replay) return replayed(c.replay);
  let m = c.row,
    undo = [],
    done = { tour: null, key: null, files: [] };
  try {
    // 2. the tour: the seat's time and money, as short keys
    let opened = await openTour(plan.auth, plan.tour);
    done.tour = opened.tour;
    done.key = opened.key;
    undo.push(() => endTour(plan.auth, opened.tour.id));
    // 3. the seat
    let seat = await upsertSeat(plan.auth.tenant.id, plan.sub, plan.seat);
    // Undo removes only a row THIS call made (a seat that existed is never touched: planMint refuses one,
    // and `created` guards the race). Nothing references it yet; the seat.mint_failed event keeps the record.
    if (seat.created) undo.push(() => sql`DELETE FROM agents WHERE tenant = ${plan.auth.tenant.id} AND sub = ${plan.sub} AND created_at = ${seat.created_at}`);
    // 4. the three files, in the agent's own section
    let hold = await getGrant(opened.receipt.holding_grant),
      files = { "SOUL.md": soul, "MEMORY.md": starterMemory(plan), "MATRIX.md": matrixFrom(plan, hold, { id: opened.tour.id, until: opened.receipt.until }) };
    for (let [key, content] of Object.entries(files)) {
      let w = await writeMemory(plan.auth.tenant.id, seatPartition(plan.name), key, content, ["seat", key.toLowerCase().replace(".md", "")], ACTOR);
      done.files.push({ id: w.id, partition: w.partition, key: w.key });
      undo.push(() => forgetMemory(plan.auth.tenant.id, w.id));
    }
    // 5. the receipt
    let [row] = await sql`UPDATE seat_mints SET status = 'minted', tour_id = ${opened.tour.id}, error = NULL, updated_at = now() WHERE id = ${m.id} RETURNING *`;
    await recordEvent(
      "seat.minted",
      { mint: m.id, sub: plan.sub, blueprint: plan.seat.blueprint, sponsor: plan.seat.sponsor, tour: opened.tour.id, key: opened.key.id, rail: m.rail, payment_ref: m.payment_ref, paid_cents: m.paid_cents, caps: plan.tour.caps, budget: plan.tour.budget },
      plan.auth.tenant.id,
      ACTOR,
    );
    return {
      status: 201,
      body: {
        mint: mintView(row),
        seat: { tenant: seat.tenant, sub: seat.sub, blueprint: seat.blueprint, sponsor: seat.sponsor, owner: seat.owner, status: seat.status },
        tour: done.tour,
        key: done.key, // shown once: hand it to the agent
        files: done.files,
      },
    };
  } catch (err) {
    for (let step of undo.reverse()) await Promise.resolve().then(step).catch((e) => console.error("[seat-mint] undo", m.id, e?.message || e));
    let why = String(err?.code || err?.message || err).slice(0, 300);
    await sql`UPDATE seat_mints SET status = 'failed', error = ${why}, updated_at = now() WHERE id = ${m.id}`.catch(() => {});
    await recordEvent("seat.mint_failed", { mint: m.id, sub: plan.sub, error: why }, plan.auth.tenant.id, ACTOR).catch(() => {});
    throw err;
  }
}

export async function listMints(tenant, limit = 100) {
  let rows = tenant
    ? await sql`SELECT * FROM seat_mints WHERE tenant = ${tenant} ORDER BY created_at DESC LIMIT ${limit}`
    : await sql`SELECT * FROM seat_mints ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(mintView);
}
