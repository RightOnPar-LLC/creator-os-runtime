#!/usr/bin/env node
// Do the fixed-window tests still test anything now that they run inside inOneWindow (harness.js)? For each
// rule below this takes the rule OUT, runs those tests, and expects the test NAMED for it to fail. A break
// that nothing notices, or that only some other test notices, is counted as not noticed.
//
//   node test/window-controls.mjs        (from the repo root; about a minute)
//
// It edits files under src/ and test/ and always puts them back (also on Ctrl-C). It first runs the tests
// untouched and expects them to PASS, so a red result below means "the break was noticed".
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const bunDir = join(here, "node_modules", "bun", "bin");
const bun = ["bun.exe", "bun"].map((n) => join(bunDir, n)).find((p) => existsSync(p));
if (!bun) (console.error("test/node_modules missing: run `npm ci` in test/ first"), process.exit(2));

const ONLY = "7\\. rate limit|7a\\. |GUEST_MAX_PER_HOUR|guest writes are rate-capped";
const METER = "export async function checkNamedRateLimit(key, max) {\n  let t = Math.floor(Date.now() / 60000) * 60000,";

// [what is taken out, file, exact text, what it becomes, the test that has to notice]
const BREAKS = [
  ["the meter never refuses",
    "src/grants.js", "  return a.count <= max;", "  return true;",
    /exceeding RATE_LIMIT_PER_MIN/],
  ["the meter refuses one call late",
    "src/grants.js", "  return a.count <= max;", "  return a.count <= max + 1;",
    /exceeding RATE_LIMIT_PER_MIN/],
  ["the meter refuses one call early",
    "src/grants.js", "  return a.count <= max;", "  return a.count < max;",
    /exceeding RATE_LIMIT_PER_MIN/],
  ["one MCP tools/call is counted twice",
    "src/routes/mcp.js", "await verifyGrant(bearerToken(e), l[s], null, !1);", "await verifyGrant(bearerToken(e), l[s], null);",
    /a single MCP tools\/call spends exactly one/],
  ["the count is not kept in a row under the grant's id",
    "src/grants.js", "VALUES (${key}, ${t}, 1)", "VALUES (${\"x:\" + key}, ${t}, 1)",
    /counters are Postgres-backed/],
  ["the meter's minute starts 30 seconds off the clock's (the harness would be reasoning about the wrong window)",
    "src/grants.js", METER, METER.replace("Math.floor(Date.now() / 60000) * 60000", "Math.floor((Date.now() - 30000) / 60000) * 60000 + 30000"),
    /counters are Postgres-backed/],
  ["a guest's memory writes are not metered",
    "src/memory.js", "  if (!(await checkNamedRateLimit(`mw:${gx.grantId}`, gx.ratePerMin)))", "  if (false)",
    /guest writes are rate-capped/],
  ["the guest mint cap is gone",
    "src/guest.js", "OR guest_fingerprints.count < ${GUEST_MAX_PER_HOUR})", "OR true)",
    /GUEST_MAX_PER_HOUR/],
  // the rule itself
  ["inOneWindow keeps the answer of a run that straddled a turn",
    "test/harness.js", "    if (Math.floor(Date.now() / windowMs) === w) {", "    if (true) {",
    /a run that straddled a turn is thrown away/],
  ["inOneWindow runs a failure again though the window did not turn",
    "test/harness.js", "      if (err) throw err;\n", "      if (err && attempt < 3) continue;\n      if (err) throw err;\n",
    /a failure inside one window is the failure/],
  ["inOneWindow lets a third straddled run count",
    "test/harness.js", "    if (attempt === 3) throw new Error(", "    if (attempt === 3) return out;\n    if (attempt === 3) throw new Error(",
    /three straddled runs in a row is a loud failure/],
];

const run = () => spawnSync(bun, ["test", "--timeout", "30000", "runtime.test.js", "-t", ONLY], { cwd: here, env: { ...process.env, RUNTIME_ENTRY: "" }, encoding: "utf8" });
const originals = new Map();
const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };
process.on("SIGINT", () => (restore(), process.exit(130)));

let bad = 0;
try {
  const control = run();
  if (control.status !== 0) {
    console.error("CONTROL RUN FAILED: the fixed-window tests are red with nothing taken out. Fix that first.\n" + ((control.stderr || "") + (control.stdout || "")).slice(-1500));
    process.exit(1);
  }
  console.log("control run: the fixed-window tests pass with nothing taken out\n");
  for (const [what, rel, from, to, mustFail] of BREAKS) {
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
    const failed = ((r.stderr || "") + (r.stdout || "")).match(/\(fail\) [^\n]*/g) || [];
    const hit = failed.find((l) => mustFail.test(l));
    if (r.status !== 0 && hit) console.log(`noticed        ${what}\n               -> ${hit.replace(/^\(fail\) /, "").slice(0, 120)}`);
    else {
      console.log(`NOT NOTICED    ${what}\n               ${r.status === 0 ? "(every test passed)" : `(the test named for it passed; failed instead: ${failed[0] || "the run, outright"})`}`);
      bad++;
    }
  }
} finally {
  restore();
}
console.log(bad ? `\n${bad} of ${BREAKS.length} breaks were NOT noticed (or could not be applied).` : `\nall ${BREAKS.length} breaks were noticed.`);
process.exit(bad ? 1 : 0);
