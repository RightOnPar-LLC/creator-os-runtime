#!/usr/bin/env node
// Do the cancel tests (section 18c of runtime.test.js) really test anything? For each rule that the 2026-10-09
// change put into src/grants.js this takes the rule OUT of the source, runs those tests, and expects them to
// FAIL. A rule whose removal nothing notices is a rule with no test. Same method as tours-controls.mjs.
//
//   node test/cancel-controls.mjs        (from the repo root; about a minute)
//
// It edits src/grants.js and always puts it back (also on Ctrl-C). It first runs the tests untouched and expects
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
  ["a cancel does not look again for keys issued under a grant while it ran",
    "src/grants.js",
    "          for (let child of late) await cancel(child.id);\n",
    ""],
  ["a cancel works out what a grant gives back from the row as it was BEFORE the late keys under it let go",
    "src/grants.js",
    "let held = late.length ? (await r`SELECT reserved FROM grants WHERE id = ${id}`)[0].reserved : i.reserved,",
    "let held = i.reserved,"],
  ["the door lets in a key whose grant above has ended",
    "src/grants.js",
    "    if (above) throw new HttpError(401, \"grant_revoked\", { why: \"a grant above this one has ended\" });\n",
    ""],
  ["the door looks only one grant up",
    "src/grants.js",
    "WHERE c.id = ${id}\n        UNION ALL SELECT p.id, p.parent, p.status FROM grants p JOIN up ON p.id = up.parent)\n      SELECT g.*,",
    "WHERE c.id = ${id})\n      SELECT g.*,"],
  ["the door counts only a CANCELLED grant above as ended (not one that ran out or was captured)",
    "src/grants.js",
    "(SELECT up.id FROM up WHERE up.status <> 'active' LIMIT 1) AS ended_above",
    "(SELECT up.id FROM up WHERE up.status = 'revoked' LIMIT 1) AS ended_above"],
  ["a key settles although a grant above it has ended",
    "src/grants.js",
    "    if (!s || s.status !== \"active\" || (await endedAbove(r, s.id)))",
    "    if (!s || s.status !== \"active\")"],
  ["a key issues another although a grant above it has ended",
    "src/grants.js",
    "      if (!P || P.status !== \"active\" || (await endedAbove(H, P.id)))",
    "      if (!P || P.status !== \"active\")"],
  ["a cancel that loses a lock wait is not tried again",
    "src/grants.js",
    "      if (!isDeadlock(err) || attempt >= CANCEL_TRIES) throw err;",
    "      throw err;"],
  ["a cancel is tried again after ANY failure, not only a lost lock wait",
    "src/grants.js",
    "      if (!isDeadlock(err) || attempt >= CANCEL_TRIES) throw err;",
    "      if (attempt >= CANCEL_TRIES) throw err;"],
  ["a cancel gives up one try sooner than it says",
    "src/grants.js",
    "const CANCEL_TRIES = 3;",
    "const CANCEL_TRIES = 2;"],
  ["a cancel goes on one try longer than it says",
    "src/grants.js",
    "const CANCEL_TRIES = 3;",
    "const CANCEL_TRIES = 4;"],
  ["a lost lock wait is known only by its words, not by its code (40P01)",
    "src/grants.js",
    "String(err?.errno ?? err?.code ?? \"\") === \"40P01\" || /deadlock detected/i.test(String(err?.message || \"\"))",
    "/deadlock detected/i.test(String(err?.message || \"\"))"],
  ["a lost lock wait is known only by its code, not by its words",
    "src/grants.js",
    "String(err?.errno ?? err?.code ?? \"\") === \"40P01\" || /deadlock detected/i.test(String(err?.message || \"\"))",
    "String(err?.errno ?? err?.code ?? \"\") === \"40P01\""],
  ["a try that failed leaves its list of cancelled keys in the answer",
    "src/grants.js",
    "  for (let attempt = 1; ; attempt++) {\n    n = [];\n",
    "  for (let attempt = 1; ; attempt++) {\n"],
  ["one candidate that fails ends the sweep's whole pass",
    "src/grants.js",
    "      console.error(\"[reaper] left for the next pass:\", id, err?.message || err);\n",
    "      throw err;\n"],
  ["the keys under one grant are cancelled in whatever order the database lists them",
    "src/grants.js",
    "SELECT id FROM sub ORDER BY depth DESC, id`;\n        for (let { id } of s) await cancel(id);",
    "SELECT id FROM sub ORDER BY depth DESC`;\n        for (let { id } of s) await cancel(id);"],
];

const once = () => spawnSync(bun, ["test", "runtime.test.js", "-t", "18c\\. a cancel"], { cwd: here, env: { ...process.env, RUNTIME_ENTRY: "" }, encoding: "utf8", timeout: 300000 });
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
    console.error("CONTROL RUN FAILED: the cancel tests are red with nothing taken out. Fix that first.\n" + (control.stderr || "").slice(-1500));
    process.exit(1);
  }
  console.log("control run: the cancel tests pass with nothing taken out\n");
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
    } else console.log(`noticed        ${what}\n               -> ${failed.length ? failed[0].replace(/^\(fail\) 18c\.[^>]*> /, "").slice(0, 110) : "the run failed outright"}`);
  }
} finally {
  restore();
}
console.log(bad ? `\n${bad} of ${BREAKS.length} breaks were NOT noticed (or could not be applied).` : `\nall ${BREAKS.length} breaks were noticed.`);
process.exit(bad ? 1 : 0);
