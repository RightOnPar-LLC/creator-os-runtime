#!/usr/bin/env node
// Do the tests of the admin's list of grants (section 25 of runtime.test.js) really test anything? For each rule of
// GET /api/admin/grants (src/routes/admin.js) this takes the rule OUT of the source, runs those tests, and expects them
// to FAIL. A rule whose removal nothing notices is a rule with no test. Same method as orphans-controls.mjs.
//
//   node test/admin-grants-controls.mjs        (from the repo root; about a minute)
//
// It edits that file and always puts it back (also on Ctrl-C). It first runs the tests untouched and expects them to
// PASS, so a red result below means "the break was noticed", not "the tests were already red".
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
  ["the status filter is not applied to the page",
    "src/routes/admin.js",
    "FROM grants\n      WHERE (${st}::text IS NULL OR status = ${st})",
    "FROM grants\n      WHERE (TRUE)"],
  ["the tenant filter is not applied to the page",
    "src/routes/admin.js",
    "AND (${tn}::text IS NULL OR tenant = ${tn})\n      ORDER BY",
    "AND TRUE\n      ORDER BY"],
  ["the offset is ignored (every page is the first)",
    "src/routes/admin.js",
    "LIMIT ${limit} OFFSET ${offset}`",
    "LIMIT ${limit}`"],
  ["the limit is ignored (every page is 200 long)",
    "src/routes/admin.js",
    "LIMIT ${limit} OFFSET ${offset}`",
    "LIMIT 200 OFFSET ${offset}`"],
  ["grants that share a moment have no second sort key",
    "src/routes/admin.js",
    "ORDER BY created_at DESC, id DESC LIMIT",
    "ORDER BY created_at DESC LIMIT"],
  ["the total ignores the filters",
    "src/routes/admin.js",
    "count(*)::int AS n FROM grants WHERE (${st}::text IS NULL OR status = ${st}) AND (${tn}::text IS NULL OR tenant = ${tn})`",
    "count(*)::int AS n FROM grants WHERE TRUE`"],
  ["an unknown status is ignored instead of refused",
    "src/routes/admin.js",
    "!GRANT_STATUSES.includes(status)) throw new HttpError(400, \"status_invalid\", { allowed: GRANT_STATUSES });",
    "!GRANT_STATUSES.includes(status)) status = undefined;"],
  ["a malformed tenant is not refused",
    "src/routes/admin.js",
    "  if (tenant !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new HttpError(400, \"tenant_invalid\");\n",
    ""],
  ["a limit or offset that cannot be read falls back to the default",
    "src/routes/admin.js",
    "throw new HttpError(400, `${name}_invalid`, { min, max });",
    "return unset;"],
  ["a limit or offset out of range is let through",
    "src/routes/admin.js",
    " || Number(raw) < min || Number(raw) > max)",
    ")"],
  ["asked with nothing, the list is not the newest 200",
    "src/routes/admin.js",
    "\"limit\", 1, 1000, 200)",
    "\"limit\", 1, 1000, 100)"],
  ["expired and captured grants cannot be asked for",
    "src/routes/admin.js",
    "const GRANT_STATUSES = [\"active\", \"revoked\", \"expired\", \"captured\"];",
    "const GRANT_STATUSES = [\"active\", \"revoked\"];"],
  ["the list is not the admin's only (no requireAdmin)",
    "src/routes/admin.js",
    "app.get(\"/api/admin/grants\", requireAdmin, async (e) => {",
    "app.get(\"/api/admin/grants\", async (e) => {"],
  ["the list is oldest first",
    "src/routes/admin.js",
    "ORDER BY created_at DESC, id DESC LIMIT",
    "ORDER BY created_at ASC, id DESC LIMIT"],
  ["a key the route does not know is ignored",
    "src/routes/admin.js",
    "throw new HttpError(400, \"query_unknown\", { allowed: GRANT_LIST_KEYS });",
    "continue;"],
  ["a key given twice is not refused (only the first is read)",
    "src/routes/admin.js",
    "    if (values.length !== 1) throw new HttpError(400, \"query_repeated\", { allowed: GRANT_LIST_KEYS });\n",
    ""],
  ["the answer does not say which filters were applied",
    "src/routes/admin.js",
    "    status: st,\n    tenant: tn,\n",
    ""],
];

const once = () => spawnSync(bun, ["test", "--timeout", "30000", "runtime.test.js", "-t", "25\\. the admin"], { cwd: here, env: { ...process.env, RUNTIME_ENTRY: "" }, encoding: "utf8", timeout: 300000 });
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
    console.error("CONTROL RUN FAILED: the tests of the admin's list of grants are red with nothing taken out. Fix that first.\n" + out(control).slice(-1500));
    process.exit(1);
  }
  console.log("control run: the tests of the admin's list of grants pass with nothing taken out\n");
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
    } else console.log(`noticed        ${what}\n               -> ${failed.length ? failed[0].replace(/^\(fail\) 25\.[^>]*> /, "").slice(0, 110) : "the run failed outright"}`);
  }
} finally {
  restore();
}
console.log(bad ? `\n${bad} of ${BREAKS.length} breaks were NOT noticed (or could not be applied).` : `\nall ${BREAKS.length} breaks were noticed.`);
process.exit(bad ? 1 : 0);
