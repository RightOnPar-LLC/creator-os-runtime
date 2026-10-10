#!/usr/bin/env node
// Do the cancel, the sweep and the capture (src/grants.js, src/escrow.js) hold up when they REALLY run at the same
// time? The suite's database is PGlite on one connection, so there nothing ever waits for a lock: section 18c of
// runtime.test.js stages each interleaving with a trigger. This script is the other half. It runs the same
// functions, unchanged, against a real Postgres over the pool production opens (Bun.SQL, 10 connections), fires
// them at each other for many rounds, and after EVERY round checks every balance.
//
//   DATABASE_URL=postgres://... node test/concurrency-real-pg.mjs              (about a minute and a half)
//   DATABASE_URL=postgres://... node test/concurrency-real-pg.mjs --controls   (does a red result ever show?)
//
//   --rounds N    rounds per scenario (default 120, 40, 60, 30)      --only 1,2    which scenarios
//   --seed N      the shapes of the trees (not the timing) repeat    --remote-ok   a host that is not this machine
//   --controls    nine rules are taken out of the source in turn, as it is loaded; each must turn a check red
//
// NOT part of `node test/run.mjs`: it needs a real Postgres, and each lock cycle costs the second Postgres waits
// before it ends one (deadlock_timeout).
//
// THE DATABASE MUST BE A THROWAWAY. The sweep (reapExpiredGrants) is not per tenant: it ends every grant in the
// database that has run out. So this refuses a Railway host outright, refuses any host but this machine unless
// --remote-ok is given, and before it writes anything wants proof the database is its own: either EMPTY (it
// then makes the runtime's tables and marks the database), or marked by an earlier run. The URL is never printed. ONE RUN AT A TIME on a database: a second run's sweep would take this run's grants, and Postgres
// counts deadlocks for the database as a whole.
//
// WHAT IS RUN (0 is one fact, 1 to 4 are rounds):
//   0. Two transactions take two rows in opposite order. What does this Bun hand back for the one Postgres ends?
//      (grants.js retries a cancel on errno "40P01".)
//   1. Keys are issued under a grant while it is being cancelled (issueChildGrant against revokeGrantTree).
//   2. Cancels, sweeps (reapExpiredGrants) and captures (captureEscrow) over the same payer keys, so that they
//      end up holding what each other wants. Postgres ends one side. The cancel must start again and finish, the
//      sweep must go on to its next candidate, a capture must fail with nothing changed.
//   3. Two or three cancels over grants that overlap (the same grant, a grant and one under it, two siblings).
//   4. One payment, one credit. A key is funded with 100 and holds it for a payee. The hold's own key then
//      tries to pledge the same 100 to a second payee: through the door (refused), and with the second hold
//      already written under the first as the old code wrote it, for all of the 100 and for 40 of it.
//      Whatever is captured, however often and all at once, payees are credited 100 in all, never 200.
//
// WHAT MUST BE TRUE AFTER EVERY ROUND, for every grant of the round (audit() below):
//   held      what is held on a grant is exactly what the grants under it account for: an active one its whole
//             budget, an ended one what it settled plus what is still held on it
//   settled   what a grant has settled is its own charges plus what was captured directly under it (ledger)
//   alive     nothing is active under a grant that has ended
//   over      settled plus held is never more than the budget
//   once      a grant that ended let go exactly once, of exactly what it had not used; a hold was paid out at
//             most once, and the credit is the same amount, to the payee the hold names
//   ledger    the same balances by another road: from the ledger rows, the statuses and the budgets, without
//             reading what any grant under it says it holds or has settled (it follows from the rules above;
//             it is kept because it is the sentence that matters: nobody is out more than was really used)
//   overpaid  the holds under a grant never paid out more than that grant was given
//
// AND, beside the balances: a cancel never fails on a lost lock wait; a sweep never stops; after the sweep's
// passes nothing that had run out is still active, and where nothing else could end it the sweep did; no id is
// in the answer of two cancels. (A cancel gives up after three lost waits in a row: that is CANCEL_TRIES in
// grants.js and not a fault of the arithmetic. It is red here all the same, with the number of tries, because
// it is the one thing this exists to show does not happen under this load. The most tries any one cancel
// needed is printed, so that it can be seen how near the limit this load comes.)
//
// EXIT: 0 nothing wrong, and each race below was really seen. 1 a rule was broken, or something failed that
// should not (the round is printed: who did what, in what order, and every row). 2 the database or the machine
// (no URL, refused, connection lost): says nothing about the code. 3 nothing wrong, but one of these was never
// seen, so the run proves less than it should (run it again, or with more --rounds): a key written after the
// cancel had read its list; a cancel that lost a lock wait and finished on a retry; a sweep that went on after
// a candidate was ended; a capture that lost a lock wait; the sweep alone ending what had run out, a payment
// hold among it; two cancels in flight at the same moment; two captures of one hold in flight at the same moment.
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const here = dirname(SELF);
const root = resolve(here, "..");
const bunDir = join(here, "node_modules", "bun", "bin");
const pinnedBun = ["bun.exe", "bun"].map((n) => join(bunDir, n)).find((p) => existsSync(p));

// Started with node (as the other scripts here are): hand over to the Bun pinned in test/package.json, which is
// the Bun production runs (deploy/Dockerfile).
if (!globalThis.Bun) {
  if (!pinnedBun) (console.error("test/node_modules missing: run `npm ci` in test/ first"), process.exit(2));
  process.exit(spawnSync(pinnedBun, [SELF, ...process.argv.slice(2)], { cwd: here, stdio: "inherit" }).status ?? 2);
}

// ---- what was asked ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const ONLY = (valueOf("--only") || "1,2,3,4").split(",").map(Number);
const ROUNDS = flag("--rounds") ? Number(valueOf("--rounds")) : null;
const DEFAULT_ROUNDS = { 1: 120, 2: 40, 3: 60, 4: 30 };
const SEED = Number(valueOf("--seed") ?? Date.now() % 1e9);
const die = (code, text) => (console.error(text), process.exit(code));
if (ROUNDS !== null && !(Number.isInteger(ROUNDS) && ROUNDS >= 1)) die(2, "--rounds takes a whole number, 1 or more");
if (!ONLY.length || !ONLY.every((n) => DEFAULT_ROUNDS[n])) die(2, "--only takes scenario numbers 1 to 4, e.g. --only 1,2");

// ---- the negative controls ----------------------------------------------------------------------
// Each takes ONE rule out of the source as it is loaded (nothing on disk is touched) and names the signal that
// must then show. A check that stays quiet with its rule gone checks nothing.
const CONTROLS = [
  { name: "a cancel does not look again for keys issued under a grant while it ran", scenario: 1, rounds: 80, signal: "alive",
    edits: [["grants.js", "          for (let child of late) await cancel(child.id);\n", ""]] },
  { name: "a cancel works out what a grant gives back from the row as it was before the late keys under it let go", scenario: 1, rounds: 80, signal: "held",
    edits: [["grants.js", "let held = late.length ? (await r`SELECT reserved FROM grants WHERE id = ${id}`)[0].reserved : i.reserved,", "let held = i.reserved,"]] },
  { name: "a cancel that loses a lock wait is not tried again", scenario: 2, rounds: 150, signal: "cancelFailed",
    edits: [["grants.js", "      if (!isDeadlock(err) || attempt >= CANCEL_TRIES) throw err;", "      throw err;"]] },
  { name: "the sweep stops at the first candidate it cannot release", scenario: 2, rounds: 200, signal: "sweepThrew",
    edits: [["grants.js", "      failed.push({ id, error: String(err?.message || err).slice(0, 200) });", "      throw err;"]] },
  { name: "the sweep never lets go of a grant that has ever had a key under it", scenario: 2, rounds: 60, signal: "sweepLeft",
    edits: [["grants.js", "  let waiting = await tx`SELECT 1 FROM grants WHERE parent = ${g.id} AND status = 'active' LIMIT 1`;", "  let waiting = await tx`SELECT 1 FROM grants WHERE parent = ${g.id} LIMIT 1`;"]] },
  { name: "the sweep never refunds a payment hold that has run out", scenario: 2, rounds: 60, signal: "sweepLeft",
    edits: [["grants.js", "WHERE status='active' AND exp <= ${nowSec()} ORDER BY depth DESC LIMIT ${limit}`", "WHERE status='active' AND exp <= ${nowSec()} AND (scope->'escrow') IS NULL ORDER BY depth DESC LIMIT ${limit}`"]] },
  { name: "the sweep takes what a grant gives back off the grant above it twice (the ledger row is right)", scenario: 2, rounds: 80, signal: "held",
    edits: [["grants.js", "    let c = subtractUsage(normalizeUsage(parseJson(p.reserved)), unspent);", "    let c = subtractUsage(normalizeUsage(parseJson(p.reserved)), { ...unspent, usd_cents: unspent.usd_cents * 2 });"]] },
  { name: "a capture pays out a hold's whole amount, whatever was pledged on under it", scenario: 4, rounds: 5, signal: "overpaid",
    edits: [["escrow.js", "  return Math.max(0, budget - paid - held);", "  return budget;"]] },
  { name: "a capture does not wait while a hold under it is still open", scenario: 4, rounds: 5, signal: "held",
    edits: [["escrow.js", "    if (below.length) return void (out.reason = \"pledged_to_a_hold_below\");\n", ""]] },
];
const SIGNALS = ["alive", "held", "cancelFailed", "sweepThrew", "sweepLeft", "overpaid"];
// In a control run each scenario stops as soon as its signal has shown.
const BROKEN = process.env.REALPG_BREAK !== undefined ? CONTROLS[Number(process.env.REALPG_BREAK)] : null;
const UNTIL = BROKEN ? BROKEN.signal : null;

// ---- the database: a throwaway, or nothing runs ---------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) die(2, "DATABASE_URL is not set. Give this a THROWAWAY Postgres (how: src/README.md, \"Real concurrency\").");
let where, password = "";
try {
  const u = new URL(DATABASE_URL);
  where = { host: u.hostname.toLowerCase().replace(/\.$/, ""), port: u.port || "5432", db: decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default)" };
  password = decodeURIComponent(u.password || "");
} catch {
  die(2, "DATABASE_URL does not read as a URL (it is not printed)");
}
// Anything that may carry the URL or its password is passed through this before it is printed.
const clean = (text) => {
  let s = String(text).split(DATABASE_URL).join("[DATABASE_URL]");
  if (password) s = s.split(password).join("[password]").split(encodeURIComponent(password)).join("[password]");
  return s.replace(/postgres(ql)?:\/\/[^\s"'`]+/gi, "[url]");
};
// By its name this only knows Railway's own hosts. A custom domain or a bare address is not this machine either,
// so it is refused below unless --remote-ok says otherwise; and whatever the host, a database that is not empty
// and not marked as this script's own is refused further down, before anything is written.
if (/(^|\.)railway\.(app|com|internal)$|(^|\.)rlwy\.net$/.test(where.host)) die(2, `refused: ${where.host} is a Railway host. This script ends grants across the whole database; it never runs there.`);
const THIS_MACHINE = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(where.host);
if (!THIS_MACHINE && !flag("--remote-ok")) die(2, `refused: ${where.host} is not this machine. If it really is a throwaway database, say so with --remote-ok.`);

if (flag("--controls")) {
  // Every run below is this same script, started afresh so the source loads afresh. First with nothing taken
  // out: every signal must stay at 0, or a red result further down would mean nothing.
  const child = (args, env = {}) => {
    const r = spawnSync(pinnedBun || process.execPath, [SELF, ...args, "--seed", String(SEED)], { cwd: here, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    const out = { status: r.status, result: line ? JSON.parse(line.slice(7)) : null, tail: clean(((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-12).join("\n")) };
    // the database or the machine, in any of the runs: that is not a control failing
    if (out.status === 2) die(2, `a run could not be made; this says nothing about the code:\n${out.tail}`);
    if (!out.result) die(1, `a run stopped without a result (exit ${out.status}):\n${out.tail}`);
    return out;
  };
  console.log("controls: one rule is taken out of the source at a time; the check named for it must go red\n");
  const base = child(["--rounds", "25"]);
  const quiet = SIGNALS.every((s) => !base.result.signals[s]) && base.result.violations === 0 && base.result.unexpected === 0;
  console.log(`${quiet ? "PASS" : "FAIL"}  nothing taken out: no signal, no violation (${base.result.rounds} rounds, ${base.result.deadlocks.client} deadlocks)`);
  if (!quiet) die(1, `\nthe untouched run is already red, so the controls say nothing:\n${base.tail}`);
  let missed = 0;
  CONTROLS.forEach((c, n) => {
    const r = child(["--only", String(c.scenario), "--rounds", String(c.rounds)], { REALPG_BREAK: String(n) });
    const seen = r.result.signals[c.signal] || 0;
    if (!seen) missed++;
    console.log(`${seen ? "PASS" : "FAIL"}  ${c.name}\n        ${seen ? `noticed: "${c.signal}" showed ${seen} time(s) within ${r.result.rounds} round(s)` : `NOT noticed in ${r.result.rounds} rounds`}`);
  });
  console.log(`\n${CONTROLS.length - missed} of ${CONTROLS.length} noticed`);
  process.exit(missed ? 1 : 0);
}

// Nothing leaves this process but the database connection, and no key of the estate is used.
for (const k of ["POSTGRES_URL", "BRAIN_URL", "COG_BRIDGE_URL", "COG_BRIDGE_TOKEN", "COG_SYNC_TOKEN", "OLLAMA_URL", "LSP_MCP_URL"]) delete process.env[k];
process.env.GRANT_SIGNING_KEY = "realpg-concurrency-test-signing-key";

if (BROKEN) {
  const texts = new Map();
  for (const [file, from, to] of BROKEN.edits) {
    const path = join(root, "src", file);
    const text = texts.get(path) ?? readFileSync(path, "utf8");
    if (text.split(from).length !== 2) die(2, `control "${BROKEN.name}": the text to take out of src/${file} is not there exactly once. The source moved; bring CONTROLS up to date.`);
    texts.set(path, text.replace(from, () => to));
  }
  Bun.plugin({
    name: "realpg-control",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/](grants|escrow)\.js$/ }, (args) => ({ contents: texts.get(resolve(args.path)) ?? readFileSync(args.path, "utf8"), loader: "js" }));
    },
  });
}

// A machine can drop loopback connections whose own (client) port falls in certain stretches of port numbers
// (found on Windows, 2026-10-09; test/loopback-check.mjs says whether a machine does, test/harness.js has the
// story). The pool below opens its connections once and keeps them, so only its start is exposed, and this Bun
// waits 30 s on a connection that never answers. So first plain connections are made and dropped until 40 in a
// row got through: the OS hands client ports out in rising order, so the pool's come from a stretch that works.
let loopbackLost = 0;
if (THIS_MACHINE) {
  const { connect } = await import("node:net");
  const reaches = () =>
    new Promise((done) => {
      const s = connect({ host: where.host.replace(/^\[|\]$/g, ""), port: Number(where.port) });
      const end = (ok) => (s.destroy(), done(ok));
      s.setTimeout(500, () => end(false)).once("connect", () => end(true)).once("error", () => end(false));
    });
  for (let good = 0, t0 = Date.now(); good < 40; ) {
    if (await reaches()) good++;
    else if (((good = 0), loopbackLost++, Date.now() - t0 > 60000)) die(2, `nothing answers at ${where.host}:${where.port} (tried for a minute). Is the database up? On this machine also: node test/loopback-check.mjs`);
  }
}

const src = (file) => import(pathToFileURL(join(root, "src", file)).href);
const { sql, migrateSchema, getGrant, getTenant } = await src("db.js");
const { loadGrantSigningKey } = await src("tokens.js");
const { grantsLeftUnderEnded, issueChildGrant, mintRootGrant, reapExpiredGrants, revokeGrantTree, settleGrantUsage } = await src("grants.js");
const { buildEscrow, captureEscrow, openEscrow } = await src("escrow.js");
const { newId, nowSec } = await src("util.js");

class Trouble extends Error {} // the database or the machine, not the code: exit 2
const lostConnection = (e) => /^ERR_POSTGRES_(CONNECTION|IDLE_TIMEOUT|LIFETIME_TIMEOUT)/.test(String(e?.code || ""));
const one = async (q) => Object.values((await sql.unsafe(q))[0])[0];
// PROOF THAT THE DATABASE IS THIS SCRIPT'S OWN, before a single thing is written. Either it is empty: no table,
// view, sequence or function of anybody's, in any schema. Then it is marked FIRST (one table whose name says
// what it is, so that a run cut short after that still finds its own database) and the runtime's tables are
// made. Or it carries the mark from an earlier run, and still holds no tenant but this script's. Anything else
// is somebody's database. The names are looked up the way the runtime will look them up (unqualified, through
// the search path), so a table of the same name in another schema cannot stand in for the one really used.
const MARK = "realpg_this_database_is_a_throwaway";
const NOT_OURS = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";
const there = `the database at ${where.host}:${where.port}/${where.db}`;
try {
  const things =
    (await one(`SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${NOT_OURS}`)) +
    (await one(`SELECT count(*)::int FROM pg_proc c JOIN pg_namespace n ON n.oid = c.pronamespace WHERE ${NOT_OURS}`));
  const marked = await one(`SELECT to_regclass('${MARK}') IS NOT NULL`);
  if (things && !marked) die(2, `refused: ${there} is not empty (${things} tables, views, sequences, indexes or functions) and does not carry this script's mark. It runs on an EMPTY database, which it then marks as its own, or on one it marked before.`);
  if (marked) {
    const foreign = (await one("SELECT to_regclass('tenants') IS NOT NULL")) ? await one("SELECT count(*)::int FROM tenants WHERE name NOT LIKE 'realpg:%'") : 0;
    if (foreign) die(2, `refused: ${there} carries this script's mark but holds ${foreign} tenant(s) it did not make.`);
  }
  if (!marked) await sql.unsafe(`CREATE TABLE ${MARK} (made_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await migrateSchema();
  await loadGrantSigningKey();
} catch (e) {
  die(2, `could not use ${there}: ${clean(e?.message || e)}${THIS_MACHINE && /^ERR_POSTGRES_CONNECTION/.test(String(e?.code)) ? ". If the database is up, this can be the machine: node test/loopback-check.mjs" : ""}`);
}
const server = { version: await one("SHOW server_version"), isolation: await one("SHOW default_transaction_isolation"), wait: await one("SHOW deadlock_timeout") };
// revokeGrantTree's second look leans on READ COMMITTED (the note above it says so).
if (server.isolation !== "read committed") die(2, `this database runs at "${server.isolation}"; production and the notes in src/grants.js are READ COMMITTED`);
// Open the whole pool now (many queries at once, each slow enough that none is reused), and count the backends.
const backends = new Set((await Promise.all(Array.from({ length: 40 }, () => sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.25)`))).map((r) => r[0].pid)).size;
if (backends < 2) die(2, "the client opened only one connection, so nothing here would run at the same time");

// ---- watching, without changing what runs ---------------------------------------------------------
// Every transaction of the runtime goes through sql.begin. This passes each call on with the same function and
// hands back the same answer or the same error; it only notes who made the call (which cancel, which sweep) and
// how it ended. That is how a cancel's tries are counted, and how a sweep is seen to go on after a candidate failed.
const who = new AsyncLocalStorage();
const seen = { transactions: 0, open: 0, mostOpen: 0, deadlocks: [], shapes: new Map() };
const isDeadlock = (e) => String(e?.errno ?? "") === "40P01" || /deadlock detected/i.test(String(e?.message || ""));
const begin = sql.begin.bind(sql);
sql.begin = (...args) => {
  const tx = { ok: false, value: undefined, error: null };
  who.getStore()?.tx.push(tx);
  seen.transactions++;
  // The runtime's own function is called once the transaction has a connection: from then until it returns,
  // the transaction is open in Postgres. Counted to show how many really were open at the same time.
  const body = args.pop();
  const counted = async (t) => {
    seen.mostOpen = Math.max(seen.mostOpen, ++seen.open);
    try {
      return await body(t);
    } finally {
      seen.open--;
    }
  };
  return begin(...args, counted).then(
    (value) => ((tx.ok = true), (tx.value = value), value),
    (error) => {
      tx.error = error;
      if (isDeadlock(error)) {
        seen.deadlocks.push(error);
        const shape = `${error?.constructor?.name} code=${error?.code} errno=${JSON.stringify(error?.errno)} message=${JSON.stringify(String(error?.message).split("\n")[0])}`;
        seen.shapes.set(shape, (seen.shapes.get(shape) || 0) + 1);
      }
      throw error;
    },
  );
};
// The sweep prints one line per pass that left something. Counted here, not shown (they are in the totals).
let reaperLines = 0;
const realError = console.error;
console.error = (...a) => (String(a[0]).startsWith("[reaper]") ? void reaperLines++ : realError(...a));

// ---- small tools ----------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rngState = SEED | 0;
const rnd = () => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const range = (n) => Array.from({ length: n }, (_, i) => i);
const pick = (list) => list[int(0, list.length - 1)];
const RUN = newId("run").slice(4, 12);
const budget = (usd_cents, calls = 0) => ({ usd_cents, calls, deploys: 0 });
const short = (id) => String(id).slice(0, 9);
const serverDeadlocks = async () => Number(await one("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()"));
// Postgres writes its counters a moment after the transaction ends: read until the number has stood still.
const settledServerDeadlocks = async (atLeast = 0) => {
  let last = await serverDeadlocks();
  for (let still = 0, t0 = Date.now(); (still < 4 || last < atLeast) && Date.now() - t0 < 10000; ) {
    await sleep(300);
    const now = await serverDeadlocks();
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
};

async function newTenant(tag) {
  const id = newId("t");
  await sql`INSERT INTO tenants (id, name, tier, allowed_targets) VALUES (${id}, ${`realpg:${RUN}:${tag}`}, 'house', ${{}}::jsonb)`;
  return { id, root: (await mintRootGrant(await getTenant(id))).row };
}
const ALL = ["grant.issue", "grant.read"];
const issue = async (parent, sub, b, caps = ALL) => (await issueChildGrant(parent, { sub, caps, ttlSec: 3600, budget: b }, "realpg")).row;
const spend = (id, calls) => settleGrantUsage(id, budget(0, calls), "realpg:work", "work");
const hold = async (payer, amount, payee) => (await openEscrow(payer, { amount, payee_tenant: payee, condition: { kind: "receipt:mesh" } }, "realpg")).row;
const cancel = (id) => revokeGrantTree(id, "realpg", "realpg");
// A grant has run out when its end is behind us. No key can be issued that way, so the end is moved by hand,
// for a whole subtree at once (a key never outlives the one above it).
const runOut = (ids) => (ids.length ? sql`UPDATE grants SET exp = ${nowSec() - 60} WHERE id IN ${sql(ids)}` : null);
const statusOf = async (ids) => new Map((ids.length ? await sql`SELECT id, status FROM grants WHERE id IN ${sql(ids)}` : []).map((r) => [r.id, r.status]));

// One thing done in a round: when it started and ended, how it ended, and every transaction it made.
let roundStart = 0;
async function act(kind, what, fn, delay, after = false) {
  if (delay) await delay;
  const rec = { kind, what, after, from: performance.now() - roundStart, to: 0, ok: false, value: undefined, error: null, tx: [] };
  try {
    rec.value = await who.run(rec, fn);
    rec.ok = true;
  } catch (e) {
    rec.error = e;
  }
  rec.to = performance.now() - roundStart;
  return rec;
}
// Starts are spread out so that the others land before, inside and after the cancel. `turns` are turns of the
// event loop (a few microseconds each when nothing is waiting), for the gaps a timer is too coarse for.
const turns = async (n) => {
  for (let i = 0; i < n; i++) await new Promise(setImmediate);
};
const spread = (ms) => (rnd() < 0.5 ? turns(int(0, 60)) : sleep(rnd() * ms));

// ---- the rules ------------------------------------------------------------------------------------
const KEYS = ["usd_cents", "calls", "deploys"];
const vec = (j) => {
  const o = typeof j === "string" ? JSON.parse(j) : j || {};
  return KEYS.map((k) => Number(o[k] || 0));
};
const plus = (a, b) => a.map((x, i) => x + b[i]);
const minus = (a, b) => a.map((x, i) => x - b[i]);
const same = (a, b) => a.every((x, i) => x === b[i]);
const zero = () => [0, 0, 0];
const show = (a) => `{usd_cents ${a[0]}, calls ${a[1]}, deploys ${a[2]}}`;

async function audit(tenant) {
  const rows = await sql`SELECT id, parent, depth, sub, status, budget, reserved, settled, scope->'escrow'->>'payee_tenant' AS payee FROM grants WHERE tenant = ${tenant} ORDER BY depth, created_at, id`;
  const ledger = await sql`SELECT l.id, l.tenant, l.grant_id, l.parent, l.kind, l.usd_cents, l.calls, l.deploys FROM ledger l JOIN grants g ON g.id = l.grant_id WHERE g.tenant = ${tenant} ORDER BY l.id`;
  const by = new Map(rows.map((g) => [g.id, { ...g, b: vec(g.budget), held: vec(g.reserved), settled: vec(g.settled), kids: [], own: zero(), releases: [], captures: [], credits: [] }]));
  for (const g of by.values()) if (g.parent) by.get(g.parent)?.kids.push(g);
  for (const l of ledger) {
    const g = by.get(l.grant_id),
      amount = [l.usd_cents, l.calls, l.deploys];
    if (l.kind === "settle" || l.kind === "self-settle") g.own = plus(g.own, amount);
    else if (l.kind === "release") g.releases.push(amount);
    else if (l.kind === "escrow-capture") g.captures.push(amount);
    else if (l.kind === "mesh-credit") g.credits.push(Object.assign(amount, { to: l.tenant }));
  }
  const broken = [];
  const say = (rule, g, text) => broken.push({ rule, grant: g.id, text: `${rule}: ${short(g.id)} (${g.sub}, ${g.status}) ${text}` });
  // What a grant takes from the one above it, from the ledger and the statuses alone: all of its budget while it
  // is active or once it was paid out; after it ended any other way, what it and everything under it used.
  const takes = (c) => (c.status === "active" || c.status === "captured" ? c.b : c.kids.reduce((a, k) => plus(a, takes(k)), c.own));
  const paidOutBelow = (g) => g.kids.reduce((a, k) => a + k.captures.reduce((x, c) => x + c[0], 0) + paidOutBelow(k), 0);
  for (const g of by.values()) {
    const accounted = g.kids.reduce((a, c) => plus(a, c.status === "active" ? c.b : plus(c.settled, c.held)), zero());
    if (!same(g.held, accounted)) say("held", g, `holds ${show(g.held)}, the grants under it account for ${show(accounted)}`);
    const charged = g.kids.reduce((a, c) => c.captures.reduce(plus, a), g.own);
    if (!same(g.settled, charged)) say("settled", g, `has settled ${show(g.settled)}, the ledger says ${show(charged)}`);
    const above = g.parent ? by.get(g.parent) : null;
    if (g.status === "active" && above && above.status !== "active") say("alive", g, `is active under ${short(above.id)}, which is ${above.status}`);
    if (KEYS.some((_, i) => g.settled[i] + g.held[i] > g.b[i])) say("over", g, `settled ${show(g.settled)} + held ${show(g.held)} is more than its budget ${show(g.b)}`);
    const unused = minus(minus(g.b, g.settled), g.held);
    const shouldLetGo = (g.status === "revoked" || g.status === "expired") && g.parent ? 1 : 0;
    if (g.releases.length !== shouldLetGo) say("once", g, `let go ${g.releases.length} time(s), should be ${shouldLetGo}`);
    else if (shouldLetGo && !same(g.releases[0], unused)) say("once", g, `gave back ${show(g.releases[0])}, what it had not used is ${show(unused)}`);
    const shouldPay = g.status === "captured" ? 1 : 0;
    if (g.captures.length !== shouldPay || g.credits.length !== shouldPay) say("once", g, `was paid out ${g.captures.length} time(s) and credited ${g.credits.length} time(s), should be ${shouldPay}`);
    else if (shouldPay && (g.captures[0][0] !== unused[0] || g.credits[0][0] !== g.captures[0][0])) say("once", g, `paid out ${g.captures[0][0]}, credited ${g.credits[0][0]}, what it held itself is ${unused[0]}`);
    else if (shouldPay && g.credits[0].to !== g.payee) say("once", g, `is held for ${g.payee} and the credit went to ${g.credits[0].to}`);
    const fromLedger = g.kids.reduce((a, c) => plus(a, takes(c)), g.own);
    if (!same(plus(g.held, g.settled), fromLedger)) say("ledger", g, `held + settled is ${show(plus(g.held, g.settled))}, the ledger and the statuses under it give ${show(fromLedger)}`);
    if (paidOutBelow(g) > g.b[0]) say("overpaid", g, `was given ${g.b[0]} and the holds under it paid out ${paidOutBelow(g)}`);
    if (!["active", "revoked", "expired", "captured"].includes(g.status)) say("status", g, "has a status this script does not know");
  }
  return { broken, by, ledger };
}

// ---- keeping count --------------------------------------------------------------------------------
const signals = Object.fromEntries(SIGNALS.map((s) => [s, 0]));
const total = { rounds: 0, violations: 0, unexpected: 0, printed: 0 };
const newCount = () => ({
  rounds: 0, violations: 0, unexpected: 0, deadlocks: 0,
  cancels: 0, cancelLost: 0, cancelRetried: 0, cancelRetriedOk: 0, cancelFailed: 0, mostTries: 0, together: 0, shared: 0,
  sweeps: 0, sweepReleased: 0, sweepLost: 0, sweepWentOn: 0, sweepLostLast: 0, sweepReleasedAfter: 0, sweepLeftEnded: 0, dueStillActive: 0,
  captures: 0, captured: 0, captureLost: 0, captureLostReplayed: 0, captureMet: 0, otherLost: 0, quietRounds: 0, quietDeadlocks: 0, quietRunOut: 0, holdsRefunded: 0,
  issued: 0, issueRefused: 0, lateSeen: 0, lateRounds: 0, doorTried: 0, doorRefused: 0, mostCredited: 0, paid: 0, credited: 0,
});
const count = { 1: newCount(), 2: newCount(), 3: newCount(), 4: newCount() };

const outcome = (a) => {
  if (a.ok) {
    const v = a.value;
    if (a.kind === "cancel") return `ended ${v.length}`;
    if (a.kind === "sweep") return `released ${v.ids.length}, left ${v.failed.length}`;
    if (a.kind === "capture") return v.captured ? `paid out ${v.amount}` : `not paid (${v.reason})`;
    return typeof v === "string" ? v : "ok";
  }
  return `FAILED ${isDeadlock(a.error) ? "lost a lock wait (40P01)" : clean(a.error?.status ? reasonOf(a.error) : a.error?.message || a.error)}`;
};
function printRound(s, n, acts, state, broken, notes) {
  if (total.printed++ >= 3) return console.log(`  (scenario ${s} round ${n}: ${broken.length + notes.length} more finding(s), not printed)`);
  console.log(`\n  ---- scenario ${s}, round ${n}, seed ${SEED}: what happened, in the order things started ----`);
  for (const a of [...acts].sort((x, y) => x.from - y.from))
    console.log(`    ${a.from.toFixed(1).padStart(7)} to ${a.to.toFixed(1).padStart(7)} ms  ${a.kind.padEnd(8)} ${String(a.what).padEnd(22)} ${outcome(a)}${a.tx.length > 1 ? `  [${a.tx.length} transactions: ${a.tx.map((t) => (t.ok ? "ok" : isDeadlock(t.error) ? "40P01" : "failed")).join(", ")}]` : ""}`);
  console.log("    the rows afterwards (budget / held / settled as usd_cents,calls):");
  for (const g of state.by.values())
    console.log(`      ${"  ".repeat(g.depth)}${short(g.id)} ${g.sub.padEnd(18)} ${g.status.padEnd(8)} ${g.b[0]},${g.b[1]} / ${g.held[0]},${g.held[1]} / ${g.settled[0]},${g.settled[1]}`);
  console.log("    the ledger, oldest first:");
  for (const l of state.ledger) console.log(`      #${l.id} ${l.kind.padEnd(14)} ${short(l.grant_id)} -> ${l.parent ? short(l.parent) : "-"}  ${l.usd_cents},${l.calls}`);
  for (const b of broken) console.log(`    BROKEN ${b.text}`);
  for (const t of notes) console.log(`    NOT EXPECTED ${t}`);
}
// After a round: who lost a lock wait and what became of it; anything that failed and should not have; the rules.
const EXPECTED = {
  cancel: [],
  sweep: [],
  capture: [],
  issue: ["parent_not_active"],
  settle: ["grant_not_active"],
  door: ["escrow_custodian_cannot_pay"],
};
// Why something was refused, in the runtime's own word. (A key issued from a row that was read after its grant was
// cancelled is refused before any lock is taken: "attenuation_violation", with the reason in the detail.)
const reasonOf = (e) => (e?.message === "attenuation_violation" && e.detail?.length === 1 ? e.detail[0] : String(e?.code && e?.status ? e.code : e?.message));
async function close(s, n, tenant, acts, extra = []) {
  const c = count[s],
    notes = [...extra];
  for (const a of acts) {
    const gone = [a.error, ...a.tx.map((t) => t.error)].find(lostConnection);
    if (gone) throw new Trouble(`the connection to the database was lost in scenario ${s}, round ${n}: ${clean(gone.code)}`);
    const lost = a.tx.filter((t) => isDeadlock(t.error)).length;
    c.deadlocks += lost;
    if (a.kind === "cancel") {
      if (!a.after) c.cancels++;
      c.cancelLost += lost;
      c.cancelRetried += a.tx.length - 1;
      c.mostTries = Math.max(c.mostTries, a.tx.length);
      if (a.ok && a.tx.length > 1) c.cancelRetriedOk++;
      // A cancel is the one caller that must not fail on a lost lock wait: it tries three times (grants.js).
      if (!a.ok && isDeadlock(a.error)) (c.cancelFailed++, signals.cancelFailed++, notes.push(`a cancel of ${a.what} failed on a lost lock wait, after ${a.tx.length} tr${a.tx.length === 1 ? "y" : "ies"}`));
      else if (!a.ok) notes.push(`a cancel of ${a.what} failed: ${clean(a.error?.message || a.error)}`);
    } else if (a.kind === "sweep") {
      if (!a.after) c.sweeps++;
      if (a.ok) c.sweepReleased += a.value.ids.length;
      c.sweepLost += lost;
      if (!a.ok) (signals.sweepThrew++, notes.push(`a sweep stopped: ${clean(a.error?.message || a.error)}`));
      else if (a.value.failed.length !== a.tx.filter((t) => t.error).length) notes.push(`a sweep said it left ${a.value.failed.length}, ${a.tx.filter((t) => t.error).length} of its transactions failed`);
      a.tx.forEach((t, i) => {
        if (!t.error) return;
        if (!isDeadlock(t.error)) return notes.push(`a sweep candidate failed with something other than a lost lock wait: ${clean(t.error?.message || t.error)}`);
        const later = a.tx.slice(i + 1);
        later.length ? c.sweepWentOn++ : c.sweepLostLast++;
        c.sweepReleasedAfter += later.filter((x) => x.ok && x.value === true).length;
      });
    } else if (a.kind === "capture") {
      if (!a.after) c.captures++;
      if (!a.after && a.ok && a.value.captured) c.captured++;
      if (!a.ok && isDeadlock(a.error)) c.captureLost++;
      else if (!a.ok) notes.push(`a capture of ${a.what} failed: ${clean(a.error?.message || a.error)}`);
    } else {
      c.otherLost += lost;
      if (lost) notes.push(`${a.kind} ${a.what} lost a lock wait; the notes in grants.js say it takes one row and cannot`);
      if (!a.ok && !isDeadlock(a.error) && !EXPECTED[a.kind]?.includes(reasonOf(a.error)))
        notes.push(`${a.kind} ${a.what} failed: ${clean(a.error?.message || a.error)}`);
    }
  }
  const state = await audit(tenant);
  for (const b of state.broken) if (b.rule in signals) signals[b.rule]++;
  c.rounds++;
  total.rounds++;
  c.violations += state.broken.length;
  c.unexpected += notes.length;
  total.violations += state.broken.length;
  total.unexpected += notes.length;
  if (state.broken.length || notes.length) printRound(s, n, acts, state, state.broken, notes);
  return state;
}

// ---- 0. what this Bun hands back for a real deadlock ----------------------------------------------
async function fact() {
  await sql`CREATE TABLE IF NOT EXISTS realpg_two_rows (id INT PRIMARY KEY, n INT NOT NULL DEFAULT 0)`;
  await sql`INSERT INTO realpg_two_rows (id) VALUES (1), (2) ON CONFLICT DO NOTHING`;
  let aHas, bHas;
  const aHolds = new Promise((r) => (aHas = r)),
    bHolds = new Promise((r) => (bHas = r)),
    t0 = performance.now();
  const ends = await Promise.allSettled([
    sql.begin(async (tx) => (await tx`UPDATE realpg_two_rows SET n = n + 1 WHERE id = 1`, aHas(), await bHolds, await tx`UPDATE realpg_two_rows SET n = n + 1 WHERE id = 2`)),
    sql.begin(async (tx) => (await tx`UPDATE realpg_two_rows SET n = n + 1 WHERE id = 2`, bHas(), await aHolds, await tx`UPDATE realpg_two_rows SET n = n + 1 WHERE id = 1`)),
  ]);
  const ms = performance.now() - t0,
    ended = ends.filter((e) => e.status === "rejected").map((e) => e.reason);
  return { ms, ended, error: ended[0] };
}

// ---- 1. keys issued under a grant while it is being cancelled ----------------------------------------
let cancelMs = 8; // how long a cancel takes here, learned as it goes, so the issues land while one runs
async function issueAgainstCancel(n) {
  const t = await newTenant(`1:${n}`);
  // Half the time the cancel is of the grant ABOVE the one the keys are issued under.
  const top = rnd() < 0.5 ? await issue(t.root, "agent:top", budget(0, 6000)) : null;
  const mid = await issue(top || t.root, "agent:mid", budget(0, 3000));
  // Keys already under it, some with spend and some with a key of their own: the cancel has work to do before it
  // takes `mid`, and that work is the window a new key can be issued in.
  await Promise.all(
    range(int(0, 7)).map(async (i) => {
      const k = await issue(mid, `agent:before${i}`, budget(0, int(8, 30)));
      if (rnd() < 0.5) await spend(k.id, int(1, 4));
      if (rnd() < 0.3) await issue(k, `agent:under${i}`, budget(0, int(1, 4)), ["grant.read"]);
    }),
  );
  const target = top || mid;
  roundStart = performance.now();
  const acts = await Promise.all([
    act("cancel", target.sub, () => cancel(target.id), turns(int(0, 20))),
    ...range(6).map((i) =>
      act("issue", `under ${mid.sub} #${i}`, async () => {
        const k = await issue(mid, `agent:during${i}`, budget(0, int(8, 30)));
        // and straight on: it spends, and hands a key on, before or after the cancel has reached it
        const more = await Promise.all([
          rnd() < 0.6 ? act("settle", k.sub, () => spend(k.id, int(1, 4))) : null,
          rnd() < 0.5 ? act("issue", `under ${k.sub}`, () => issue(k, `agent:under-during${i}`, budget(0, int(1, 4)), ["grant.read"])) : null,
        ]);
        return more.filter(Boolean);
      }, spread(cancelMs * 1.3)),
    ),
  ]);
  const inner = acts.flatMap((a) => (a.kind === "issue" && a.ok ? a.value : []));
  const c = count[1],
    notes = [];
  const done = acts[0];
  if (done.ok) cancelMs = cancelMs * 0.8 + (done.to - done.from) * 0.2;
  else await cancel(target.id); // it failed (counted, and the run is red); asked again so the rest can be checked
  for (const a of [...acts.slice(1), ...inner].filter((a) => a.kind === "issue")) a.ok ? c.issued++ : c.issueRefused++;
  if ((await getGrant(target.id)).status !== "revoked") notes.push(`${target.sub} was cancelled and is ${(await getGrant(target.id)).status}`);
  // Proof that the window was hit, from Postgres itself. A key whose issue ran in a transaction numbered AFTER the
  // cancel's can only have been written after the cancel had read its list. A transaction gets its number when it
  // first locks or changes a row (not at BEGIN, not for a read, not for an UPDATE that finds no row): the cancel
  // reads its list before that, the issue locks its parent with it. (Fewer than really were late: one that took
  // its number before the cancel did and finished after the list was read is late too, and not counted.)
  const cancelTx = (await sql`SELECT max(xmin::text::bigint)::text AS x FROM ledger WHERE kind = 'release' AND grant_id = ${mid.id}`)[0].x;
  const late = cancelTx === null ? 0 : (await sql`SELECT xmin::text AS x FROM ledger WHERE kind = 'reserve' AND parent = ${mid.id}`).filter((r) => Number(r.x) > Number(cancelTx)).length;
  c.lateSeen += late;
  if (late) c.lateRounds++;
  await close(1, n, t.id, [...acts, ...inner], notes);
}

// ---- 2. cancels, sweeps and captures over the same payer keys ---------------------------------------
async function cancelSweepCapture(n) {
  const t = await newTenant(`2:${n}`);
  // One round in four has no cancel in it. The notes say the sweep, a capture, an issue and a settle cannot hold
  // what each other wants, so in such a round nobody may lose a lock wait. It is also the round in which the
  // sweep alone must end everything that has run out (checked below).
  const quiet = rnd() < 0.25;
  const payers = await Promise.all(
    range(2).map(async (j) => {
      const payer = await issue(t.root, `agent:payer${j}`, budget(6000, 900), ["grant.issue", "grant.read", "escrow.hold"]);
      const out = { payer, due: [], holds: [], keys: [], lapsed: [] };
      await Promise.all([
        ...range(int(3, 5)).map(async (i) => {
          const k = await issue(payer, `agent:key${j}.${i}`, budget(0, int(20, 40)));
          out.keys.push(k);
          out.due.push(k.id);
          if (rnd() < 0.6) await spend(k.id, int(1, 5));
          if (rnd() < 0.4) {
            const u = await issue(k, `agent:under${j}.${i}`, budget(0, int(2, 6)), ["grant.read"]);
            out.due.push(u.id);
            if (rnd() < 0.5) await spend(u.id, 1);
          }
        }),
        ...range(int(4, 5)).map(async (i) => {
          const h = await hold(payer, int(50, 300), `realpg-payee:${RUN}:${n}:${j}.${i}`);
          out.holds.push(h);
          // The first hold of each payer is left alone until the round has been checked once: no deadline, no
          // receipt. So a payer that was not cancelled still holds something then, and a release that takes
          // too much off it shows. (With nothing left held on it, the runtime's "never below 0" would turn any
          // amount taken twice into the 0 that is expected anyway.)
          if (i === 0) return void (out.kept = h);
          // a hold at its deadline. With a cancel in the round it is refunded by the sweep, cancelled, or paid
          // out, whichever comes first and never two of them. In a round with no cancel no receipt comes for it:
          // then only the sweep can end it, and it must (checked below).
          if (rnd() < 0.3) (out.due.push(h.id), out.lapsed.push(h.id));
        }),
      ]);
      return out;
    }),
  );
  await runOut(payers.flatMap((p) => p.due));
  const sweep = () => act("sweep", "the whole database", async () => {
    const failed = [];
    return { ids: await reapExpiredGrants({ failed }), failed };
  }, spread(4));
  roundStart = performance.now();
  const acts = await Promise.all([
    ...payers.filter(() => !quiet).map((p) => act("cancel", p.payer.sub, () => cancel(p.payer.id), spread(3))),
    sweep(),
    ...(rnd() < 0.6 ? [sweep()] : []), // a second replica's sweep
    ...payers.flatMap((p) => p.holds.filter((h) => h !== p.kept && !(quiet && p.lapsed.includes(h.id))).flatMap((h) => range(rnd() < 0.3 ? 2 : 1).map(() => act("capture", h.sub, () => captureEscrow(h.id, { source: "realpg", ref: `rc-${n}` }), spread(5))))),
    // in a round without a cancel the keys also spend and hand keys on while the sweep comes for them
    ...(quiet ? payers.flatMap((p) => p.keys.flatMap((k) => [act("settle", k.sub, () => spend(k.id, 1), spread(4)), act("issue", `under ${p.payer.sub}`, () => issue(p.payer, "agent:more", budget(0, 5)), spread(4))])) : []),
  ]);
  const c = count[2],
    notes = [],
    lostHere = acts.reduce((a, x) => a + x.tx.filter((y) => isDeadlock(y.error)).length, 0);
  if (quiet) (c.quietRounds++, (c.quietDeadlocks += lostHere));
  if (quiet && lostHere) notes.push(`${lostHere} lock wait(s) lost in a round with no cancel in it`);
  await close(2, n, t.id, acts, notes);
  // What the passes left is left "for the next pass". This is the next pass, with nothing else running: it
  // must leave nothing, and every candidate that was left must have ended by now (here, or by a cancel).
  const left = [...new Set(acts.filter((a) => a.kind === "sweep" && a.ok).flatMap((a) => a.value.failed.map((f) => f.id)))];
  const after = [];
  const next = await act("sweep", "the next pass", async () => {
    const failed = [];
    return { ids: await reapExpiredGrants({ failed }), failed };
  }, null, true);
  if (next.ok && next.value.failed.length) after.push(`the next pass, alone, still left ${next.value.failed.length}`);
  // Now, BEFORE anything is cancelled to tidy up: every grant that had run out must have ended. In a round with
  // no cancel in it only the sweep can have done that (a hold may also have been paid out), so this is where a
  // sweep that leaves grants lying is seen. With a cancel in the round it shows less: the cancel ends them too.
  const due = await statusOf(payers.flatMap((p) => p.due));
  const lying = [...due].filter(([, status]) => status === "active");
  if (lying.length) (signals.sweepLeft++, (c.dueStillActive += lying.length), after.push(`${lying.length} grant(s) that had run out are still active after the sweep's passes, with nothing else running: ${lying.map(([id]) => short(id)).join(", ")}`));
  if (quiet) c.quietRunOut += [...due].filter(([, status]) => status === "expired").length;
  // The holds among them that the sweep refunded (the audit then wants one release of each one's whole amount).
  // In a round with no cancel that is every one of them: nothing else was sent for them.
  const lapsed = payers.flatMap((p) => p.lapsed);
  c.holdsRefunded += lapsed.filter((id) => due.get(id) === "expired").length;
  const unrefunded = quiet ? lapsed.filter((id) => due.get(id) !== "expired") : [];
  if (unrefunded.length && !lying.length) (signals.sweepLeft++, after.push(`${unrefunded.length} payment hold(s) that had run out, in a round with no cancel and no receipt, were not refunded by the sweep`));
  c.sweepLeftEnded += left.filter((id) => due.get(id) !== "active").length;
  // A capture that lost its wait threw with nothing changed. The receipt is sent again; so is the call.
  const again = [];
  for (const a of acts.filter((x) => x.kind === "capture" && !x.ok && isDeadlock(x.error))) {
    const hid = payers.flatMap((p) => p.holds).find((h) => h.sub === a.what).id;
    again.push(await act("capture", `${a.what} (again)`, () => captureEscrow(hid, { source: "realpg", ref: `rc-${n}-again` }), null, true));
    c.captureLostReplayed++;
  }
  // the receipt for the hold that was left alone comes now (its payer may have been cancelled meanwhile)
  for (const p of payers) again.push(await act("capture", `${p.kept.sub} (left alone until now)`, () => captureEscrow(p.kept.id, { source: "realpg", ref: `rc-${n}-kept` }), null, true));
  // then everything is ended, and the owner must have got back all that nobody used
  for (const p of payers) again.push(await act("cancel", `${p.payer.sub} (to finish)`, () => cancel(p.payer.id), null, true));
  c.rounds--, total.rounds--; // close() counts a round; this is the same one, checked a second time
  const end = await close(2, n, t.id, [next, ...again], after);
  const alive = [...end.by.values()].filter((g) => g.parent && g.status === "active").length;
  if (alive) (c.unexpected++, total.unexpected++, console.log(`    NOT EXPECTED scenario 2 round ${n}: ${alive} grant(s) still active after everything was cancelled`));
}

// ---- 3. cancels over grants that overlap ----------------------------------------------------------
async function overlappingCancels(n) {
  const t = await newTenant(`3:${n}`);
  const top = await issue(t.root, "agent:top", budget(0, 4000));
  const [a, b] = await Promise.all(["a", "b"].map((s) => issue(top, `agent:${s}`, budget(0, 1500))));
  const as = await Promise.all(range(int(2, 5)).map((i) => issue(a, `agent:a${i}`, budget(0, int(20, 60)))));
  const bs = await Promise.all(range(int(1, 4)).map((i) => issue(b, `agent:b${i}`, budget(0, int(20, 60)))));
  const xs = await Promise.all(as.slice(0, 2).map((k, i) => issue(k, `agent:a${i}.x`, budget(0, int(2, 8)), ["grant.read"])));
  await Promise.all([...as, ...bs, ...xs, a, b].filter(() => rnd() < 0.5).map((k) => spend(k.id, int(1, 2))));
  const targets = pick([[top, a], [top, top], [a, b, top], [top, as[0], a], [a, a, as[0]], [as[0], top], [b, top, a]]);
  const during = rnd() < 0.5; // keys are also issued under them meanwhile, so one cancel finds a grant the other did not list
  roundStart = performance.now();
  const acts = await Promise.all([
    ...targets.map((g) => act("cancel", g.sub, () => cancel(g.id), spread(2))),
    ...(during ? [a, a, top, as[0], b].map((g, i) => act("issue", `under ${g.sub} #${i}`, () => issue(g, `agent:during${i}`, budget(0, int(2, 8))), spread(cancelMs))) : []),
  ]);
  const c = count[3],
    notes = [];
  for (const x of acts.filter((x) => x.kind === "issue")) x.ok ? c.issued++ : c.issueRefused++;
  for (const x of acts.filter((x) => x.kind === "cancel" && !x.ok && isDeadlock(x.error))) await cancel(targets.find((g) => g.sub === x.what).id); // failed (counted, and the run is red); asked again
  // Each grant is ended by ONE of the calls: no id is in two answers, and the answers together are exactly the
  // grants that are now cancelled.
  const lists = acts.filter((x) => x.kind === "cancel" && x.ok).map((x) => x.value),
    all = lists.flat();
  if (new Set(all).size !== all.length) notes.push(`a grant is in the answer of two cancels: ${all.filter((id, i) => all.indexOf(id) !== i).map(short).join(", ")}`);
  // Were two of them really in flight at the same moment, and did more than one of them end something?
  const flights = acts.filter((x) => x.kind === "cancel");
  if (flights.some((x, i) => flights.some((y, j) => j > i && x.from < y.to && y.from < x.to))) c.together++;
  if (lists.filter((l) => l.length).length > 1) c.shared++;
  const state = await close(3, n, t.id, acts, notes);
  if (acts.every((x) => x.kind !== "cancel" || x.ok)) {
    const cancelled = [...state.by.values()].filter((g) => g.status === "revoked").map((g) => g.id);
    if (cancelled.length !== all.length || !cancelled.every((id) => all.includes(id)))
      (c.unexpected++, total.unexpected++, console.log(`    NOT EXPECTED scenario 3 round ${n}: ${cancelled.length} grants are cancelled, the cancels answered ${all.length}`));
    // everything under each cancelled grant is ended
    const under = (g) => [g, ...g.kids.flatMap(under)];
    for (const g of new Set(targets)) {
      const still = under(state.by.get(g.id)).filter((x) => x.status === "active").length;
      if (still) (c.unexpected++, total.unexpected++, console.log(`    NOT EXPECTED scenario 3 round ${n}: ${still} grant(s) still active under ${g.sub}`));
    }
  }
}

// ---- 4. one payment, one credit -------------------------------------------------------------------
async function onePaymentOneCredit(n) {
  const t = await newTenant(`4:${n}`);
  const payee = (s) => `realpg-payee:${RUN}:${n}:${s}`;
  const terms = (to, amount = 100) => ({ amount, payee_tenant: payee(to), condition: { kind: "receipt:mesh" } });
  const funded = (s) => issue(t.root, `agent:payer-${s}`, budget(100, 10), ["grant.read", "escrow.hold"]); // 100 and not a cent more
  const [byDoor, whole, part] = await Promise.all([funded("door"), funded("whole"), funded("part")]);
  // A hold written UNDER a hold, the way the old code wrote it when a hold's own key asked. The door in buildEscrow
  // is the only thing that stops that today, so here it is written past the door.
  const pledgedOn = async (payer, outer, to, amount) => {
    const made = buildEscrow(payer, terms(to, amount), "house");
    return (await issueChildGrant(outer, made.childSpec, "realpg", { escrow: { ...made.escrow, payer_grant: outer.id }, heldUntil: 0 })).row;
  };
  // (a) as things are: the payer holds its 100 for a payee, and the hold's own key asks to pledge it again
  const first = await hold(byDoor, 100, payee("a"));
  // (b) as things were: the whole 100 already pledged on to a second payee, under the first hold
  const outer = await hold(whole, 100, payee("outer"));
  const inner = await pledgedOn(whole, outer, "inner", 100);
  // (c) as things were, in part: 40 of the 100 pledged on. That lower hold is then given back, not paid.
  const upper = await hold(part, 100, payee("upper"));
  const lower = await pledgedOn(part, upper, "lower", 40);
  const pay = (h, tag) => act("capture", h.sub, () => captureEscrow(h.id, { source: "realpg", ref: `rc-${n}-${tag}` }), spread(4));
  const again = (h) => act("capture", `${h.sub} (again)`, () => captureEscrow(h.id, { source: "realpg", ref: `rc-${n}-again` }), null, true);
  roundStart = performance.now();
  const acts = await Promise.all([
    ...range(3).map((i) => act("door", `${first.sub} pledges again #${i}`, () => openEscrow(first, terms("b"), "realpg"), spread(4))),
    act("door", `${inner.sub} pledges again`, () => openEscrow(inner, terms("c"), "realpg"), spread(4)),
    act("door", `${lower.sub} pledges again`, () => openEscrow(lower, terms("d", 40), "realpg"), spread(4)),
    // every delivery arrives three times at once; for (c) only the upper hold's, while the lower one is still open
    ...range(3).flatMap((i) => [pay(first, `a${i}`), pay(outer, `o${i}`), pay(inner, `i${i}`), pay(upper, `u${i}`)]),
  ]);
  // Then one thing at a time. Every receipt once more. The lower hold of (c) is given back. Then its upper hold's
  // receipt comes again, and now it must pay the whole 100: nothing under it is pledged any more.
  const later = [];
  for (const h of [first, outer, inner, outer, upper]) later.push(await again(h));
  later.push(await act("cancel", `${lower.sub} (given back)`, () => cancel(lower.id), null, true));
  later.push(await again(upper));
  const c = count[4],
    notes = [];
  for (const a of acts.filter((x) => x.kind === "door")) {
    c.doorTried++;
    if (!a.ok && a.error?.code === "escrow_custodian_cannot_pay" && a.error?.status === 403) c.doorRefused++;
    else notes.push(`a hold's own key asked to pledge its value again and was not refused: ${a.ok ? "a hold was opened" : clean(a.error?.message)}`);
  }
  // Did two captures of ONE hold really meet? Counted only when another capture of the same hold was in flight
  // at the same moment as the one that paid (by their recorded start and end), and was not paid.
  for (const paid of acts.filter((x) => x.kind === "capture" && x.ok && x.value.captured))
    c.captureMet += acts.filter((x) => x !== paid && x.kind === "capture" && x.what === paid.what && x.ok && !x.value.captured && x.from < paid.to && paid.from < x.to).length;
  const state = await close(4, n, t.id, [...acts, ...later], notes);
  // The count that matters: what each payer paid in, and what payees were credited out of it. Each of the three
  // ends the same way: 100 paid in, 100 credited, and the payer out exactly 100.
  const below = (g) => [g, ...g.kids.flatMap(below)];
  for (const [payer, holds] of [[byDoor, 1], [whole, 2], [part, 2]]) {
    const row = state.by.get(payer.id),
      credited = below(row).reduce((a, g) => a + g.credits.reduce((x, k) => x + k[0], 0), 0),
      opened = below(row).length - 1;
    c.paid += 100;
    c.credited += credited;
    c.mostCredited = Math.max(c.mostCredited, credited);
    if (credited > 100) signals.overpaid++;
    if (credited !== 100 || row.held[0] + row.settled[0] !== 100 || opened !== holds)
      (c.violations++, total.violations++, printRound(4, n, [...acts, ...later], state, [{ text: `one payment, one credit: ${payer.sub} was funded 100, has ${opened} hold(s) under it (should be ${holds}), payees were credited ${credited}, and it is out ${row.held[0] + row.settled[0]}` }], []));
  }
}

// ---- run --------------------------------------------------------------------------------------------
const SCENARIOS = {
  1: ["a key is issued under a grant while that grant is being cancelled", issueAgainstCancel],
  2: ["cancels, sweeps and captures over the same payer keys", cancelSweepCapture],
  3: ["cancels over grants that overlap", overlappingCancels],
  4: ["one payment, one credit: a hold's own key cannot pledge the held value again", onePaymentOneCredit],
};
const pinned = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).devDependencies.bun;
console.log(`real-Postgres concurrency check${BROKEN ? `   [CONTROL: ${BROKEN.name}]` : ""}`);
console.log(`  database   PostgreSQL ${server.version} at ${where.host}:${where.port}/${where.db}, ${server.isolation}, ends a lock cycle after ${server.wait}`);
console.log(`  client     Bun ${Bun.version}${Bun.version === pinned ? " (the pinned one)" : ` (NOT the pinned ${pinned})`}, Bun.SQL as src/db.js opens it: ${backends} connections, each its own Postgres backend`);
console.log(`  seed       ${SEED}`);
if (loopbackLost) console.log(`  note       this machine dropped ${loopbackLost} plain connection(s) to the database before the run began (node test/loopback-check.mjs); the run waited until 40 in a row got through`);
console.log("");
const t0 = Date.now();
let exit = 0;
try {
  const probe = await fact();
  const e = probe.error;
  console.log("0. what this Bun hands back when Postgres ends one side of a real lock cycle");
  console.log(`   after ${(probe.ms / 1000).toFixed(2)} s, ${probe.ended.length} of 2 transactions was ended: ${e?.constructor?.name}, code ${JSON.stringify(e?.code)}, errno ${JSON.stringify(e?.errno)} (a ${typeof e?.errno}), message ${JSON.stringify(String(e?.message).split("\n")[0])}`);
  const factOk = probe.ended.length === 1 && e?.errno === "40P01";
  console.log(`   ${factOk ? 'errno is "40P01": what src/grants.js looks for first' : "NOT what src/grants.js looks for (errno \"40P01\")"}\n`);
  if (!factOk) (total.unexpected++, (exit = 1));
  seen.deadlocks.length = 0;
  seen.shapes.clear();
  const serverBefore = await settledServerDeadlocks(1);

  for (const s of ONLY) {
    const [title, round] = SCENARIOS[s],
      rounds = ROUNDS ?? DEFAULT_ROUNDS[s],
      started = Date.now();
    for (let n = 1; n <= rounds; n++) {
      await round(n);
      if (UNTIL && signals[UNTIL]) break;
    }
    const c = count[s];
    console.log(`${s}. ${title}`);
    console.log(`   ${c.rounds} rounds in ${((Date.now() - started) / 1000).toFixed(0)} s, ${c.deadlocks} deadlocks, ${c.cancelRetried} retries, ${c.violations} violations${c.unexpected ? `, ${c.unexpected} NOT EXPECTED` : ""}`);
    if (s === 1) console.log(`   keys issued while a cancel ran: ${c.issued} written, ${c.issueRefused} refused (the grant was already taken). Of those written, at least ${c.lateSeen} (in ${c.lateRounds} rounds) were written AFTER the cancel had read its list, and the cancel ended them all the same`);
    if (s === 2) {
      console.log(`   ${c.cancels} cancels: ${c.cancelLost} lock waits lost, ${c.cancelRetried} retries made; ${c.cancelRetriedOk} cancels finished after a retry, ${c.cancelFailed} failed; the most tries any one cancel needed: ${c.mostTries} (it gives up after 3)`);
      console.log(`   ${c.sweeps} sweep passes (and one more, alone, after each round) released ${c.sweepReleased} grants. Postgres ended ${c.sweepLost} of their candidates: the pass went on after ${c.sweepWentOn} of them (${c.sweepLostLast} were the last of their pass) and released ${c.sweepReleasedAfter} later candidates in the same pass. After the passes ${c.dueStillActive} grants that had run out were still active`);
      console.log(`   ${c.captures} captures: ${c.captured} paid out, ${c.captureLost} lost a lock wait (thrown to the caller, nothing changed; sent again: ${c.captureLostReplayed})`);
      console.log(`   ${c.quietRounds} rounds had no cancel in them: ${c.quietDeadlocks} lock waits lost there (the notes say none can be), and the sweep alone ended ${c.quietRunOut} grants that had run out. Payment holds the sweep refunded at their deadline, over all rounds: ${c.holdsRefunded}`);
    }
    if (s === 3) console.log(`   ${c.cancels} cancels: ${c.cancelLost} lock waits lost, ${c.cancelRetried} retries made; ${c.cancelRetriedOk} cancels finished after a retry, ${c.cancelFailed} failed; the most tries any one cancel needed: ${c.mostTries}. In ${c.together} rounds two of them were in flight at the same moment, in ${c.shared} more than one of them ended grants. ${c.issued} keys were issued under them meanwhile, ${c.issueRefused} refused`);
    if (s === 4) console.log(`   ${c.doorTried} times a hold's own key asked to pledge its value again: refused ${c.doorRefused} times. ${c.captures} captures, three at once per hold: ${c.captured} paid out, ${c.captureMet} were in flight for a hold at the same moment as the capture that paid it, and were not paid. Payers paid in ${c.paid}, payees were credited ${c.credited}; the most credited out of one payment of 100 was ${c.mostCredited}`);
    console.log("");
  }

  // Once more over everything this run made, in case a later round changed an earlier one.
  const tenants = await sql`SELECT id FROM tenants WHERE name LIKE ${`realpg:${RUN}:%`}`;
  let late = 0;
  for (const { id } of tenants) late += (await audit(id)).broken.length;
  total.violations += late;
  // A second opinion, from the runtime's own count (the admin's GET /api/admin/grants/orphans): of this run's
  // grants, none may be left active under an ended one, and no budget may be withheld above one. It reads the
  // whole database, so what earlier runs left (a --controls run leaves broken rows on purpose) is filtered out.
  let own = null;
  if (grantsLeftUnderEnded) {
    const mine = new Set(tenants.map((t) => t.id)),
      r = await grantsLeftUnderEnded({ limit: 1e6 });
    own = { left: r.orphans.filter((g) => mine.has(g.tenant)).length, withheld: r.withheld.filter((g) => mine.has(g.tenant)).length };
    if ((own.left || own.withheld) && !BROKEN) total.unexpected++;
  }
  const client = seen.deadlocks.length,
    withErrno = seen.deadlocks.filter((d) => d?.errno === "40P01").length,
    serverSaw = (await settledServerDeadlocks(serverBefore + client)) - serverBefore;
  console.log("TOTAL");
  console.log(`  rounds        ${total.rounds} (${tenants.length} tenants, all checked once more at the end: ${late} violations then)`);
  if (own) console.log(`  second look   the runtime's own count over these tenants: ${own.left} keys left active under an ended grant, ${own.withheld} grants with budget withheld above them${own.left || own.withheld ? "   NOT EXPECTED" : ""}`);
  console.log(`  transactions  ${seen.transactions}, at most ${seen.mostOpen} open in Postgres at the same time (on ${backends} connections)`);
  console.log(`  deadlocks     the client was handed ${client}, ${withErrno} of them with errno "40P01"; Postgres counted ${serverSaw}`);
  for (const [shape, k] of seen.shapes) console.log(`                ${k} x ${shape}`);
  console.log(`  retries       ${ONLY.reduce((a, s) => a + count[s].cancelRetried, 0)} (a cancel starting again after a lost lock wait)`);
  console.log(`  violations    ${total.violations}${total.unexpected ? `, and ${total.unexpected} thing(s) NOT EXPECTED` : ""}`);
  console.log(`  took          ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (client !== withErrno) (total.unexpected++, console.log("  NOT EXPECTED: a deadlock reached the client without errno \"40P01\""));
  if (client !== serverSaw) (total.unexpected++, console.log("  NOT EXPECTED: the client and Postgres do not count the same number of deadlocks"));

  // Was each race really seen? A clean run that never hit one proves less than it says.
  const unseen = [];
  const ran = (s) => ONLY.includes(s) && !UNTIL;
  if (ran(1) && !count[1].lateSeen) unseen.push("scenario 1: no key was seen written after the cancel had read its list");
  if (ran(2) && !count[2].cancelRetriedOk) unseen.push("scenario 2: no cancel lost a lock wait and finished on a retry");
  if (ran(2) && !count[2].sweepWentOn) unseen.push("scenario 2: no sweep had a candidate ended and went on");
  if (ran(2) && !count[2].captureLost) unseen.push("scenario 2: no capture lost a lock wait");
  if (ran(2) && !count[2].quietRunOut) unseen.push("scenario 2: in no round without a cancel did the sweep end a grant that had run out");
  if (ran(2) && !count[2].holdsRefunded) unseen.push("scenario 2: the sweep refunded no payment hold");
  if (ran(3) && !count[3].together) unseen.push("scenario 3: no two cancels were in flight at the same moment");
  if (ran(4) && !count[4].captureMet) unseen.push("scenario 4: no two captures of one hold were in flight at the same moment");
  if (total.violations || total.unexpected) exit = 1;
  else if (unseen.length) exit = 3;
  for (const u of unseen) console.log(`  NOT SEEN      ${u}`);
  console.log(`\n${exit === 0 ? "PASS" : exit === 3 ? "NOTHING WRONG, BUT NOT EVERYTHING WAS SEEN (run again, or with more --rounds)" : "FAIL"}`);
  console.log(`RESULT ${JSON.stringify({ rounds: total.rounds, violations: total.violations, unexpected: total.unexpected, deadlocks: { client, errno40P01: withErrno, server: serverSaw }, retries: ONLY.reduce((a, s) => a + count[s].cancelRetried, 0), mostTries: Math.max(...ONLY.map((s) => count[s].mostTries)), signals, unseen, seed: SEED, reaperLines })}`);
} catch (e) {
  if (e instanceof Trouble || lostConnection(e)) {
    console.error(`\nSTOPPED, and this says nothing about the code: ${clean(e?.message || e?.code || e)}. Run it again.`);
    exit = 2;
  } else {
    console.error(`\nSTOPPED outside any round by an error nothing here expects:\n${clean(e?.stack || e)}`);
    exit = 1;
  }
}
await sql.close().catch(() => {});
process.exit(exit);
