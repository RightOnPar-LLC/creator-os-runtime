#!/usr/bin/env node
// Do the tours tests really test anything? For each rule in src/tours.js this takes the rule OUT of the source,
// runs the tours tests, and expects them to FAIL. A rule whose removal nothing notices is a rule with no test.
//
//   node test/tours-controls.mjs        (from the repo root; takes a few minutes)
//
// It edits files under src/ and always puts them back (also on Ctrl-C). It first runs the tests untouched and
// expects them to PASS, so a red result below means "the break was noticed", not "the tests were already red".
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
  ["renewal hands the key over without checking the tour is still as it was", "src/tours.js",
    "renewals = renewals + 1, last_renewed_at = ${now}\n      WHERE id = ${tour.id} AND status = 'active' AND current_key = ${old} RETURNING id",
    "renewals = renewals + 1, last_renewed_at = ${now}\n      WHERE id = ${tour.id} RETURNING id"],
  ["renewal changes the tour's record BEFORE cancelling the key in hand", "src/tours.js",
    "  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old))",
    "  await sql`UPDATE tours SET current_key = NULL WHERE id = ${tour.id}`;\n  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old))"],
  ["a new key is issued without first cancelling every other key under the tour", "src/tours.js",
    '  await cancelKeysUnder(tour, "tour: replaced by a newer key", by);\n', ""],
  ["the alarm marks the tour frozen even when the keys could not be cancelled", "src/tours.js",
    '    await cancelKeysUnder(tour, "tour: frozen (a replaced key was used again)", "runtime");\n    // (already frozen',
    '    await cancelKeysUnder(tour, "tour: frozen (a replaced key was used again)", "runtime").catch(() => []);\n    // (already frozen'],
  ["the alarm does not look again for a key issued while it was freezing", "src/tours.js",
    '    // once more: a renewal that was in hand may have issued a key between the two statements above\n    await cancelKeysUnder(tour, "tour: frozen (a replaced key was used again)", "runtime");\n', ""],
  ["the alarm has no grace: any use of a replaced key freezes", "src/tours.js",
    "\n      AND revoked_at < now() - make_interval(secs => ${TOUR_REUSE_GRACE_SEC}::int)`;", "`;"],
  ["the alarm trusts the words on the tour's CURRENT key", "src/tours.js",
    "    if (!tour || tour.current_key === oldKey.id) return false;", "    if (!tour) return false;"],
  ["keys replaced before an owner reissue can still raise the alarm", "src/tours.js",
    "  await sql`UPDATE grants SET revoke_reason = ${TOUR_SUPERSEDED} WHERE parent = ${tour.grant_id} AND revoke_reason = ${TOUR_RENEWED}`;\n", ""],
  ["a tour that cannot be recorded leaves its holding grant behind", "src/tours.js",
    '    await revokeGrantTree(hold.row.id, "tour: could not be recorded", auth.row.sub); // nothing is left held\n', ""],
  ["the table allows two live tours for one agent name", "src/db.js",
    "CREATE UNIQUE INDEX IF NOT EXISTS tours_one_live_per_agent ON tours(tenant, agent) WHERE status IN ('active', 'frozen');\n", ""],
  ["nothing ends a tour nobody renews", "src/tours.js",
    " OR (t.status = 'active' AND ${now}::bigint - t.last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))", ")"],
  ["nothing ends a tour whose holding grant is gone", "src/tours.js",
    "t.until <= ${now}::bigint OR g.status IS DISTINCT FROM 'active' OR", "t.until <= ${now}::bigint OR"],
  ["nothing ends a tour whose end date has passed", "src/tours.js",
    "(t.until <= ${now}::bigint OR g.status IS DISTINCT FROM 'active' OR", "(g.status IS DISTINCT FROM 'active' OR"],
  ["ending a tour does not look under the holding grant a second time", "src/tours.js",
    "  cancelled.push(...(await cancelKeysUnder(tour, `tour: ${reason}`, by)));\n", ""],
  ["the sweep leaves a working key under a frozen tour", "src/tours.js",
    "SELECT t.* FROM tours t WHERE t.status = 'frozen' AND (", "SELECT t.* FROM tours t WHERE t.status = 'no such status' AND ("],
  ["what is left counts only what the holding grant itself settled", "src/tours.js",
    "\n        UNION ALL SELECT g.id, g.settled FROM grants g JOIN sub ON g.parent = sub.id) SELECT settled FROM sub`", ") SELECT settled FROM sub`"],
  ["an extension of any size is accepted", "src/tours.js",
    "  if (until - Number(tour.until) < TOUR_MIN_EXTEND_SEC)", "  if (until <= Number(tour.until))"],
  ["an extension moves the tour's record but not the holding grant's end", "src/tours.js",
    "    let g = await tx`UPDATE grants SET exp = ${until} WHERE id = ${tour.grant_id} AND status = 'active' AND exp > ${now} RETURNING id`;",
    "    let g = await tx`SELECT id FROM grants WHERE id = ${tour.grant_id} AND status = 'active' AND exp > ${now}`;"],
  ["a token for the holding grant is accepted as a key", "src/grants.js",
    '    if (parseJson(s.scope)?.tour?.holder) throw new HttpError(401, "holding_grant");\n', ""],
  ["an old token ends a grant by the token's date, not the row's", "src/grants.js",
    "        if (g && Number(g.exp) <= nowSec()) await releaseExpiredGrant(tx, g);", "        if (g) await releaseExpiredGrant(tx, g);"],
  ["an agent's own key can open a tour", "src/tours.js",
    "export async function openTour(auth, body) {\n  ownerOnly(auth);\n", "export async function openTour(auth, body) {\n"],
  // (The 24-hour cap on a tour's key is not in this list: tours.js asks for 24 hours AND issueChildGrant caps every
  // key a non-root key issues, so taking either one out changes nothing. The cap itself is tested in section 7b.)
];

const runTours = () => spawnSync(bun, ["test", "runtime.test.js", "-t", "7c. tours"], { cwd: here, env: { ...process.env, RUNTIME_ENTRY: "" }, encoding: "utf8" });
const originals = new Map();
const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };
process.on("SIGINT", () => (restore(), process.exit(130)));

let bad = 0;
try {
  const control = runTours();
  if (control.status !== 0) {
    console.error("CONTROL RUN FAILED: the tours tests are red with nothing taken out. Fix that first.\n" + (control.stderr || "").slice(-1500));
    process.exit(1);
  }
  console.log("control run: the tours tests pass with nothing taken out\n");
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
    const r = runTours();
    writeFileSync(f, text);
    const failed = ((r.stderr || "") + (r.stdout || "")).match(/\(fail\) [^\n]*/g) || [];
    if (r.status === 0) {
      console.log(`NOT NOTICED    ${what}`);
      bad++;
    } else console.log(`noticed        ${what}\n               -> ${failed.length ? failed[0].replace(/^\(fail\) 7c\. tours[^>]*> /, "").slice(0, 110) : "the run failed outright"}`);
  }
} finally {
  restore();
}
console.log(bad ? `\n${bad} of ${BREAKS.length} breaks were NOT noticed (or could not be applied).` : `\nall ${BREAKS.length} breaks were noticed.`);
process.exit(bad ? 1 : 0);
