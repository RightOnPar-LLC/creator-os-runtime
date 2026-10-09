#!/usr/bin/env node
// Do the tests of the admin's count (section 18d of runtime.test.js) really test anything? For each rule of
// GET /api/admin/grants/orphans (grantsLeftUnderEnded in src/grants.js, and the route in src/routes/admin.js) this
// takes the rule OUT of the source, runs those tests, and expects them to FAIL. A rule whose removal nothing
// notices is a rule with no test. Same method as cancel-controls.mjs and tours-controls.mjs.
//
//   node test/orphans-controls.mjs        (from the repo root; about a minute)
//
// It edits those files and always puts them back (also on Ctrl-C). It first runs the tests untouched and expects
// them to PASS, so a red result below means "the break was noticed", not "the tests were already red".
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const bunDir = join(here, "node_modules", "bun", "bin");
const bun = ["bun.exe", "bun"].map((n) => join(bunDir, n)).find((p) => existsSync(p));
if (!bun) (console.error("test/node_modules missing: run `npm ci` in test/ first"), process.exit(2));

// [what is taken out, file, exact text, what it becomes]
const BREAKS = [
  ["only a CANCELLED grant above counts as ended (not one that ran out or was captured)",
    "src/grants.js",
    "CASE WHEN d.status <> 'active' THEN d.id ELSE d.ended_above END,",
    "CASE WHEN d.status = 'revoked' THEN d.id ELSE d.ended_above END,"],
  ["the count looks only at the grant just above a key, not all the way up",
    "src/grants.js",
    "CASE WHEN d.status <> 'active' THEN d.id ELSE d.ended_above END,",
    "CASE WHEN d.status <> 'active' THEN d.id END,"],
  ["how the grant above ended is not carried down to the keys further below",
    "src/grants.js",
    "CASE WHEN d.status <> 'active' THEN d.status ELSE d.ended_status END,",
    "CASE WHEN d.status <> 'active' THEN d.status END,"],
  ["the nearest active grant above is not looked for past the grant just above",
    "src/grants.js",
    "CASE WHEN d.status = 'active' THEN d.id ELSE d.active_above END",
    "CASE WHEN d.status = 'active' THEN d.id END"],
  ["a grant that has ended itself is listed as a key left active",
    "src/grants.js",
    "WHERE d.status = 'active' AND d.ended_above IS NOT NULL)",
    "WHERE d.ended_above IS NOT NULL)"],
  ["every active grant is listed, whether a grant above it has ended or not",
    "src/grants.js",
    "WHERE d.status = 'active' AND d.ended_above IS NOT NULL)",
    "WHERE d.status = 'active')"],
  ["a key past its end is counted as live",
    "src/grants.js",
    "(g.exp > ${now}) AS live",
    "true AS live"],
  ["a payment hold is not marked",
    "src/grants.js",
    "(g.scope->'escrow') IS NOT NULL AS hold,",
    "false AS hold,"],
  ["only the newest 200 grants are read",
    "src/grants.js",
    "FROM grants c JOIN down d ON c.parent = d.id),",
    "FROM (SELECT * FROM grants ORDER BY created_at DESC LIMIT 200) c JOIN down d ON c.parent = d.id),"],
  ["the count of live keys is of the listed part, not of the whole table",
    "src/grants.js",
    "counts: { live: left[0]?.n_live ?? 0,",
    "counts: { live: left.filter((g) => g.live).length,"],
  ["a list cut short by the limit does not say so",
    "src/grants.js",
    "truncated: { orphans: (left[0]?.n_live ?? 0) + (left[0]?.n_past ?? 0) > left.length,",
    "truncated: { orphans: false,"],
  ["the live keys do not come first in the list",
    "src/grants.js",
    "FROM hit ORDER BY live DESC, depth, id LIMIT",
    "FROM hit ORDER BY depth DESC, id LIMIT"],
  ["what a grant has already given back is not taken off what it would give back now",
    "src/grants.js",
    "      d = subtractUsage(would, gave),\n",
    "      d = would,\n"],
  ["a grant that gave back MORE than its row says is listed as owing the difference",
    "src/grants.js",
    "calls: Math.max(0, d.calls), deploys: Math.max(0, d.deploys) };\n    if (!short.usd_cents",
    "calls: Math.abs(d.calls), deploys: Math.max(0, d.deploys) };\n    if (!short.usd_cents"],
  ["what a grant would give back now is worked out by the old sum (what is held on it is left out)",
    "src/grants.js",
    "      would = unusedOf(g, g.reserved),\n",
    "      would = unusedOf(g, zeroUsage()),\n"],
  ["only a grant's FIRST release counts as given back (a later one, which put it right, is forgotten)",
    "src/grants.js",
    "min(id) AS first_id, sum(usd_cents)::float8 AS usd_cents, sum(calls)::float8 AS calls,",
    "min(id) AS first_id, sum(usd_cents)::float8 AS usd_cents, (array_agg(calls ORDER BY id))[1]::float8 AS calls,"],
  ["a grant is listed although nothing let go into it after it had",
    "src/grants.js",
    "ON under.parent = g.id AND under.last_id > own.first_id",
    "ON under.parent = g.id"],
  ["a grant that is active is listed as holding budget back",
    "src/grants.js",
    "      WHERE g.status <> 'active' ORDER BY g.depth DESC, g.id`,",
    "      ORDER BY g.depth DESC, g.id`,"],
  ["the list is cut BEFORE the sum is done (a lower grant that owes nothing can take the place of one that owes)",
    "src/grants.js",
    "      WHERE g.status <> 'active' ORDER BY g.depth DESC, g.id`,",
    "      WHERE g.status <> 'active' ORDER BY g.depth DESC, g.id LIMIT ${limit}`,"],
  ["the lowest grant holding budget back does not come first",
    "src/grants.js",
    "      WHERE g.status <> 'active' ORDER BY g.depth DESC, g.id`,",
    "      WHERE g.status <> 'active' ORDER BY g.depth, g.id`,"],
  ["the limit does not cut the list of grants holding budget back",
    "src/grants.js",
    "    withheld: withheld.slice(0, limit),\n",
    "    withheld,\n"],
  ["the count of grants holding budget back is of the part shown, not of all of them",
    "src/grants.js",
    "past_exp: left[0]?.n_past ?? 0, withheld: withheld.length },",
    "past_exp: left[0]?.n_past ?? 0, withheld: Math.min(limit, withheld.length) },"],
  ["the total held back is of the part shown, not of all of it",
    "src/grants.js",
    "    total = addUsage(total, short);\n",
    "    if (withheld.length < limit) total = addUsage(total, short);\n"],
  ["a list of grants holding budget back that was cut short does not say so",
    "src/grants.js",
    "withheld: withheld.length > limit },",
    "withheld: false },"],
  ["the grant that holds the budget is not named",
    "src/grants.js",
    "to: g.parent, to_status: g.parent_status,",
    "to: g.id, to_status: g.status,"],
  ["anybody may ask, not only the admin",
    "src/routes/admin.js",
    "app.get(\"/api/admin/grants/orphans\", requireAdmin, async (e) => {",
    "app.get(\"/api/admin/grants/orphans\", async (e) => {"],
  ["a limit out of range is used as it was asked",
    "src/routes/admin.js",
    "Number.isFinite(asked) ? Math.min(5000, Math.max(1, asked)) : 500",
    "Number.isFinite(asked) ? asked : 500"],
  ["an empty limit is read as a number",
    "src/routes/admin.js",
    "Math.floor(Number(e.req.query(\"limit\") || NaN))",
    "Math.floor(Number(e.req.query(\"limit\")))"],
];

const once = () => spawnSync(bun, ["test", "--timeout", "30000", "runtime.test.js", "-t", "18d\\. the count"], { cwd: here, env: { ...process.env, RUNTIME_ENTRY: "" }, encoding: "utf8", timeout: 300000 });
// On some machines a run now and then dies of the harness's own trouble: its throwaway database refuses the first
// connection, or everything stalls and tests time out. Such a run says nothing either way (it is red, but not
// because a break was noticed), so it is run again. None of the breaks below makes a test hang.
const TROUBLE = /ERR_POSTGRES_CONNECTION_REFUSED|ConnectionRefused|ECONNRESET|timed out after/;
const out = (r) => (r.stderr || "") + (r.stdout || "");
const run = () => {
  let r = once();
  for (let again = 0; again < 4 && r.status !== 0 && TROUBLE.test(out(r)); again++) r = once();
  return r;
};
const originals = new Map();
const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };
process.on("SIGINT", () => (restore(), process.exit(130)));

let bad = 0;
try {
  const control = run();
  if (control.status !== 0) {
    console.error("CONTROL RUN FAILED: the tests of the count are red with nothing taken out. Fix that first.\n" + out(control).slice(-1500));
    process.exit(1);
  }
  console.log("control run: the tests of the count pass with nothing taken out\n");
  for (const [what, rel, from, to] of BREAKS) {
    const f = join(root, rel);
    const text = readFileSync(f, "utf8");
    if (!originals.has(f)) originals.set(f, text);
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const src = text.replace(/\r\n/g, "\n");
    if (src.split(from).length !== 2) {
      console.log(`CANNOT APPLY   ${what}\n               (the text was not found exactly once in ${rel}: this list is out of date)`);
      bad++;
      continue;
    }
    writeFileSync(f, src.split(from).join(to).replace(/\n/g, nl));
    const r = run();
    writeFileSync(f, text);
    const failed = out(r).match(/\(fail\) [^\n]*/g) || [];
    if (r.status === 0) {
      console.log(`NOT NOTICED    ${what}`);
      bad++;
    } else if (TROUBLE.test(out(r))) {
      console.log(`NO ANSWER      ${what}\n               (every run died of the harness's own trouble, not of the break: run this script again)`);
      bad++;
    } else console.log(`noticed        ${what}\n               -> ${failed.length ? failed[0].replace(/^\(fail\) 18d\.[^>]*> /, "").slice(0, 110) : "the run failed outright"}`);
  }
} finally {
  restore();
}
console.log(bad ? `\n${bad} of ${BREAKS.length} breaks were NOT noticed (or could not be applied).` : `\nall ${BREAKS.length} breaks were noticed.`);
process.exit(bad ? 1 : 0);
