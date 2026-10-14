#!/usr/bin/env node
// Do the tours tests really test anything? For each rule in src/tours.js this takes the rule OUT of the source,
// runs the tours tests, and expects them to FAIL. A rule whose removal nothing notices is a rule with no test.
//
//   node test/tours-controls.mjs        (from the repo root; takes a few minutes)
//
// It edits files under src/ and always puts them back (also on Ctrl-C). It first runs the tests untouched and
// expects them to PASS, so a red result below means "the break was noticed", not "the tests were already red".
// A rule that lives in two statements is taken out of both at once: `from` and `to` may be lists, one entry per site.
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
  ["a renewal hands its key over without checking it is still its turn",
    "src/tours.js",
    "renewals = renewals + 1, last_renewed_at = ${now}\n      WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id",
    "renewals = renewals + 1, last_renewed_at = ${now}\n      WHERE id = ${tour.id} RETURNING id"],
  ["a renewal takes its turn though the tour no longer points at its key",
    "src/tours.js",
    "UPDATE tours SET gen = gen + 1 WHERE id = ${tour.id} AND status = 'active' AND current_key = ${old} RETURNING gen",
    "UPDATE tours SET gen = gen + 1 WHERE id = ${tour.id} RETURNING gen"],
  ["a second renewal with the same key goes on although the first has cancelled it",
    "src/tours.js",
    "  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old)) throw new HttpError(409, \"tour_key_cancelled\", { hint: \"this key was cancelled a moment ago, by another renewal or by the owner\" });",
    "  await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub);"],
  ["a renewal blanks the tour's record before cancelling the key in hand",
    "src/tours.js",
    "  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old))",
    "  await sql`UPDATE tours SET current_key = NULL WHERE id = ${tour.id}`;\n  if (!(await revokeGrantTree(old, TOUR_RENEWED, auth.row.sub)).includes(old))"],
  ["a reissue goes ahead though the tour is no longer as it read it",
    "src/tours.js",
    "WHERE id = ${tour.id} AND status IN ('active', 'frozen') AND gen = ${Number(tour.gen)}::bigint RETURNING gen",
    "WHERE id = ${tour.id} AND status IN ('active', 'frozen') RETURNING gen"],
  ["a reissue writes its key down without checking it is still its turn",
    "src/tours.js",
    "UPDATE tours SET current_key = ${key.row.id} WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id",
    "UPDATE tours SET current_key = ${key.row.id} WHERE id = ${tour.id} RETURNING id"],
  ["a reissue answers with a key it has not checked still works",
    "src/tours.js",
    "noted.length !== 1 || (await getGrant(key.row.id))?.status !== \"active\"",
    "noted.length !== 1"],
  ["a key carries no turn number",
    "src/tours.js",
    "{ tour: { tour_id: tour.id, agent: tour.agent, gen } },",
    "{ tour: { tour_id: tour.id, agent: tour.agent } },"],
  ["the sweep cancels keys of a turn it never saw",
    "src/tours.js",
    "await cancelUnder(t, Number(t.gen), FROZEN_CANCEL, \"runtime\");",
    "await cancelUnder(t, EVERY_TURN, FROZEN_CANCEL, \"runtime\");"],
  ["the alarm cancels keys of a turn it never saw",
    "src/tours.js",
    "      let gen = Number(tour.gen);\n      await cancelUnder(tour, gen, FROZEN_CANCEL, \"runtime\");",
    "      let gen = Number(tour.gen);\n      await cancelUnder(tour, EVERY_TURN, FROZEN_CANCEL, \"runtime\");"],
  ["the alarm freezes the tour though a turn was taken since it looked",
    "src/tours.js",
    "WHERE id = ${tour.id} AND status = 'active' AND gen = ${gen}::bigint RETURNING id`;\n      if (frozen.length !== 1) continue;",
    "WHERE id = ${tour.id} AND status = 'active' RETURNING id`;\n      if (frozen.length !== 1) continue;"],
  ["a new key is issued while a key of an earlier turn still holds the tour's budget",
    "src/tours.js",
    "    if (Number(hold.still_working)) {",
    "    if (false) {"],
  ["the alarm marks the tour frozen even when the keys could not be cancelled",
    "src/tours.js",
    "      let gen = Number(tour.gen);\n      await cancelUnder(tour, gen, FROZEN_CANCEL, \"runtime\");",
    "      let gen = Number(tour.gen);\n      await cancelUnder(tour, gen, FROZEN_CANCEL, \"runtime\").catch(() => []);"],
  ["the alarm does not look again after marking the tour frozen",
    "src/tours.js",
    "      // once more: a turn up to this one may have written its key between the two statements above\n      await cancelUnder(tour, gen, FROZEN_CANCEL, \"runtime\");\n",
    ""],
  ["ending a tour does not look under it again",
    "src/tours.js",
    "  cancelled.push(...(await cancelUnder(tour, EVERY_TURN, `tour: ${reason}`, by)));\n",
    ""],
  ["a look for keys stops at the tour's own keys (a helper under a cancelled key is never found)",
    "src/tours.js",
    "\n    UNION ALL SELECT c.id, c.status, c.depth FROM grants c JOIN sub ON c.parent = sub.id)\n  SELECT id FROM sub WHERE status = 'active' ORDER BY depth ASC`;",
    ")\n  SELECT id FROM sub WHERE status = 'active' ORDER BY depth ASC`;"],
  ["cancelling looks only once",
    "src/tours.js",
    "  for (let look = 0; look < 5; look++) {\n    let live = await liveUnder(tour, gen);",
    "  for (let look = 0; look < 1; look++) {\n    let live = await liveUnder(tour, gen);"],
  ["the sweep leaves a working key under a frozen tour",
    "src/tours.js",
    "SELECT * FROM tours WHERE status = 'frozen' AND (",
    "SELECT * FROM tours WHERE status = 'no such status' AND ("],
  ["the alarm has no grace: any use of a replaced key freezes",
    "src/tours.js",
    "\n        AND revoked_at < now() - make_interval(secs => ${TOUR_REUSE_GRACE_SEC}::int)`;",
    "`;"],
  ["the alarm trusts the words on the tour's CURRENT key",
    "src/tours.js",
    "      if (!tour || tour.current_key === oldKey.id) return false;",
    "      if (!tour) return false;"],
  ["keys replaced before an owner reissue can still raise the alarm",
    "src/tours.js",
    "        await tx`UPDATE grants SET revoke_reason = ${TOUR_SUPERSEDED} WHERE parent = ${tour.grant_id} AND revoke_reason = ${TOUR_RENEWED}`;\n",
    ""],
  ["the old key of a renewal that lost its turn can still raise the alarm",
    "src/tours.js",
    "    await revokeGrantTree(key.row.id, \"tour: changed while it was being renewed\", auth.row.sub);\n    await notAnAlarm(old);\n",
    "    await revokeGrantTree(key.row.id, \"tour: changed while it was being renewed\", auth.row.sub);\n"],
  ["a tour that cannot be recorded leaves its holding grant behind",
    "src/tours.js",
    "    await revokeGrantTree(hold.row.id, \"tour: could not be recorded\", auth.row.sub); // nothing is left held\n",
    ""],
  ["a tour whose first key cannot be issued stays open and keeps the owner's budget",
    "src/tours.js",
    "    await endTourRow(tour, \"could not issue its first key\", auth.row.sub).catch((e) => console.error(\"ERR tour open clean-up\", id, e?.message || e));\n",
    ""],
  ["a renewal that cannot issue the next key says nothing on the record",
    "src/tours.js",
    "SET status = 'frozen', frozen_reason = 'a renewal could not issue the next key', current_key = NULL, gen = gen + 1",
    "SET gen = gen + 1"],
  ["a renewal whose record cannot be written leaves its new key working",
    "src/tours.js",
    "    await revokeGrantTree(key.row.id, \"tour: its renewal could not be recorded\", auth.row.sub).catch(() => {}); // never handed out either way\n",
    ""],
  ["the table allows two live tours for one agent name",
    "src/db.js",
    "CREATE UNIQUE INDEX IF NOT EXISTS tours_one_live_per_agent ON tours(tenant, agent) WHERE status IN ('active', 'frozen');\n",
    ""],
  ["nothing ends a tour nobody renews",
    "src/tours.js",
    " OR (t.status = 'active' AND ${now}::bigint - t.last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))\n      ORDER BY random() LIMIT 200`;",
    ")\n      ORDER BY random() LIMIT 200`;"],
  ["nothing ends a tour whose holding grant is gone",
    "src/tours.js",
    "t.until <= ${now}::bigint OR g.status IS DISTINCT FROM 'active' OR",
    "t.until <= ${now}::bigint OR"],
  ["nothing ends a tour whose end date has passed",
    "src/tours.js",
    "(t.until <= ${now}::bigint OR g.status IS DISTINCT FROM 'active' OR",
    "(g.status IS DISTINCT FROM 'active' OR"],
  ["the sweep ends a tour without looking at it again",
    "src/tours.js",
    "WHERE id = ${t.id} AND status IN ('active', 'frozen')\n        AND (until <= ${now}::bigint OR NOT EXISTS (SELECT 1 FROM grants g WHERE g.id = tours.grant_id AND g.status = 'active')\n          OR (status = 'active' AND ${now}::bigint - last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))\n        RETURNING id`;",
    "WHERE id = ${t.id} AND status IN ('active', 'frozen')\n        RETURNING id`;"],
  ["what is left counts only what the holding grant itself settled",
    "src/tours.js",
    "\n        UNION ALL SELECT g.id, g.settled FROM grants g JOIN sub ON g.parent = sub.id) SELECT settled FROM sub`",
    ") SELECT settled FROM sub`"],
  ["an extension of any size is accepted",
    "src/tours.js",
    "  if (until - Number(tour.until) < TOUR_MIN_EXTEND_SEC)",
    "  if (until <= Number(tour.until))"],
  ["an extension moves the tour's record but not the holding grant's end",
    "src/tours.js",
    "    let g = await tx`UPDATE grants SET exp = ${until} WHERE id = ${tour.grant_id} AND status = 'active' AND exp > ${now} RETURNING id`;",
    "    let g = await tx`SELECT id FROM grants WHERE id = ${tour.grant_id} AND status = 'active' AND exp > ${now}`;"],
  ["an extension that cannot be recorded still moves the holding grant's end",
    "src/tours.js",
    "  let moved = await sql.begin(async (tx) => {",
    "  let moved = await (async (tx) => {"],
  ["a token for the holding grant is accepted as a key",
    "src/grants.js",
    "    if (parseJson(s.scope)?.tour?.holder) throw new HttpError(401, \"holding_grant\");\n",
    ""],
  ["an old token ends a grant by the token's date, not the row's",
    "src/grants.js",
    "        if (g && Number(g.exp) <= nowSec()) await releaseExpiredGrant(tx, g);",
    "        if (g) await releaseExpiredGrant(tx, g);"],
  ["an agent's own key can open a tour",
    "src/tours.js",
    "export async function openTour(auth, body) {\n  ownerOnly(auth);\n",
    "export async function openTour(auth, body) {\n"],
  // ---- the follow-ups of pull request 37's third review ------------------------------------------------------------
  ["a reissue takes its turn before it clears the replaced keys of the alarm",
    "src/tours.js",
    "        await tx`UPDATE grants SET revoke_reason = ${TOUR_SUPERSEDED} WHERE parent = ${tour.grant_id} AND revoke_reason = ${TOUR_RENEWED}`;\n        let t = await tx`UPDATE tours SET gen = gen + 1, status = 'active', frozen_reason = NULL, current_key = NULL, last_renewed_at = ${now}\n          WHERE id = ${tour.id} AND status IN ('active', 'frozen') AND gen = ${Number(tour.gen)}::bigint RETURNING gen`;\n",
    "        let t = await tx`UPDATE tours SET gen = gen + 1, status = 'active', frozen_reason = NULL, current_key = NULL, last_renewed_at = ${now}\n          WHERE id = ${tour.id} AND status IN ('active', 'frozen') AND gen = ${Number(tour.gen)}::bigint RETURNING gen`;\n        await tx`UPDATE grants SET revoke_reason = ${TOUR_SUPERSEDED} WHERE parent = ${tour.grant_id} AND revoke_reason = ${TOUR_RENEWED}`;\n"],
  ["a reissue that loses its turn keeps the keys it had cleared (the clearing is not rolled back)",
    "src/tours.js",
    "          throw new Error(\"tour: this reissue lost its turn\"); // rolls the clearing back\n",
    "          return [];\n"],
  ["a reissue that loses its turn answers as a failure (500), not as a changed tour (409)",
    "src/tours.js",
    "        if (lost) return [];\n        throw err;\n",
    "        throw err;\n"],
  ["a real failure inside a reissue's transaction is answered as a lost turn (409)",
    "src/tours.js",
    "        if (lost) return [];\n        throw err;\n",
    "        return [];\n"],
  ["a reissue clears the alarm and takes its turn in two separate statements (no transaction)",
    "src/tours.js",
    ["turn = await sql\n      .begin(async (tx) => {\n", "        return t;\n      })\n      .catch((err) => {\n        if (lost) return [];\n"],
    ["turn = await (async (tx) => {\n", "        return t;\n      })(sql)\n      .catch((err) => {\n        if (lost) return [];\n"]],
  ["the alarm reads the key's reason before the tour",
    "src/tours.js",
    ["      let tour = (await sql`SELECT * FROM tours WHERE grant_id = ${oldKey.parent} AND status IN ('active', 'frozen')`)[0];\n      // Not directly under a live tour's holding grant (a helper's key, or the tour is over): no alarm.\n      // The tour's CURRENT key is never \"replaced\", whatever reason somebody wrote on it when cancelling it.\n      if (!tour || tour.current_key === oldKey.id) return false;\n",
     "      // asked of the database's own clock, the one that wrote revoked_at\n      let due = await sql`SELECT 1 FROM grants WHERE id = ${oldKey.id} AND revoke_reason = ${TOUR_RENEWED}\n        AND revoked_at < now() - make_interval(secs => ${TOUR_REUSE_GRACE_SEC}::int)`;\n      if (!due.length) return false;\n"],
    ["      let due = await sql`SELECT 1 FROM grants WHERE id = ${oldKey.id} AND revoke_reason = ${TOUR_RENEWED}\n        AND revoked_at < now() - make_interval(secs => ${TOUR_REUSE_GRACE_SEC}::int)`;\n      if (!due.length) return false;\n",
     "      let tour = (await sql`SELECT * FROM tours WHERE grant_id = ${oldKey.parent} AND status IN ('active', 'frozen')`)[0];\n      if (!tour || tour.current_key === oldKey.id) return false;\n"]],
  ["the next key is not asked for again when the amount it was given is refused",
    "src/tours.js",
    "      if (attempt < 8 && err?.message === \"budget_exceeds_parent_remaining\") continue;\n",
    ""],
  ["the old key of a renewal that lost its turn before issuing can still raise the alarm",
    "src/tours.js",
    "  if (turn.length !== 1) {\n    await notAnAlarm(old);\n    throw await changed(tour.id);\n  }\n",
    "  if (turn.length !== 1) throw await changed(tour.id);\n"],
  ["a frozen tour is ended for being idle (the rule sits in two statements; both are taken out)",
    "src/tours.js",
    [" OR (t.status = 'active' AND ${now}::bigint - t.last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))",
     "          OR (status = 'active' AND ${now}::bigint - last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))"],
    [" OR (${now}::bigint - t.last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))",
     "          OR (${now}::bigint - last_renewed_at > ${TOUR_IDLE_END_SEC}::bigint))"]],
  ["a renewal whose line on the record cannot be written answers 500 though the tour points at the new key",
    "src/tours.js",
    "const recordOrLog = (what, fn) => fn().catch((err) => console.error(`ERR tour: ${what} could not be written (the key was handed over)`, err?.message || err));",
    "const recordOrLog = (what, fn) => fn();"],
  ["a renewal whose issue fails after the key was written leaves that key working until the sweep",
    "src/tours.js",
    "      await cancelUnder(tour, gen, TOUR_UNFINISHED, auth.row.sub);\n",
    ""],
  ["a renewal under a tour that is being ended says frozen on the record",
    "src/tours.js",
    "    let over = await ending(tour);\n    if (over) throw new HttpError(409, over, { hint: \"the tour ended at the same moment: nobody is handed a key\" });\n",
    ""],
  ["a reissue under a tour that is being ended answers the owner with the issue's own error",
    "src/tours.js",
    "    let over = await ending(tour);\n    if (over) throw new HttpError(409, over, { hint: \"the tour ended at the same moment\" });\n",
    ""],
  ["a reason beginning tour: is not reserved",
    "src/tours.js",
    "  if (/^\\s*tour:/i.test(String(reason ?? \"\"))) throw",
    "  if (false) throw"],
  ["the owner's revoke route writes any reason",
    "src/routes/grants.js",
    "  notATourReason(reason); // \"tour: ...\" is the runtime's own (tours.js): the alarm reads one of them back\n",
    ""],
  ["the admin's revoke route writes any reason",
    "src/routes/admin.js",
    "  notATourReason(reason); // \"tour: ...\" is the runtime's own (tours.js): the alarm reads one of them back\n",
    ""],
  ["the MCP revoke tool writes any reason",
    "src/routes/mcp.js",
    "        notATourReason(reason); // \"tour: ...\" is the runtime's own (tours.js): the alarm reads one of them back\n",
    ""],
  ["the alarm path is not rate limited",
    "src/tours.js",
    "      if (look === 0 && !(await checkNamedRateLimit(`tour-alarm:${oldKey.id}`, TOUR_ALARM_MAX_PER_MIN))) return false;\n",
    ""],
  ["the list shows the newest tours, live or not",
    "src/tours.js",
    "ORDER BY (status IN ('active', 'frozen')) DESC, opened_at DESC LIMIT 100",
    "ORDER BY opened_at DESC LIMIT 100"],
  // (The 24-hour cap on a tour's key is not in this list: tours.js asks for 24 hours AND issueChildGrant caps every
  // key a non-root key issues, so taking either one out changes nothing. The cap itself is tested in section 7b.)
  // (Nor are two of the four notAnAlarm calls in renewTour: the one after a failed issue and the one after a failed
  // record. No test can show them, because no path leaves the tour where that old key could then raise the alarm:
  // after a failed issue the tour is frozen, and the alarm does nothing to a frozen tour; after a failed record the
  // tour still points at the old key, and the alarm never fires for the tour's current key; and the one step that makes
  // a tour active again is the owner's reissue, which clears the reason itself. They stay as a second guard.)
];

// (--timeout as run.mjs passes it: this bun ignores the one in bunfig.toml)
const once = () => spawnSync(bun, ["test", "--timeout", "30000", "runtime.test.js", "-t", "7c. tours"], { cwd: here, env: { ...process.env, RUNTIME_ENTRY: "" }, encoding: "utf8", timeout: 600000 });
// On some machines a run now and then dies of the harness's own trouble: its throwaway database refuses the first
// connection, or everything stalls and tests time out. Such a run says nothing either way (it is red, but not because
// a break was noticed), so it is run again (as cancel-controls.mjs does). None of the breaks below makes a test hang.
const TROUBLE = /ERR_POSTGRES_CONNECTION_REFUSED|ConnectionRefused|ECONNRESET|timed out after/;
const out = (r) => (r.stderr || "") + (r.stdout || "");
const runTours = () => {
  let r = once();
  for (let again = 0; again < 4 && r.status !== 0 && TROUBLE.test(out(r)); again++) r = once();
  return r;
};
const originals = new Map();
const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };
process.on("SIGINT", () => (restore(), process.exit(130)));

// TOURS_CONTROLS_ONLY=<words> runs only the breaks whose description contains them (the control run still comes first).
const only = process.env.TOURS_CONTROLS_ONLY || "";
let bad = 0;
try {
  const control = runTours();
  if (control.status !== 0) {
    console.error("CONTROL RUN FAILED: the tours tests are red with nothing taken out. Fix that first.\n" + (control.stderr || "").slice(-1500));
    process.exit(1);
  }
  console.log("control run: the tours tests pass with nothing taken out\n");
  for (const [what, rel, from, to] of BREAKS) {
    if (only && !what.includes(only)) continue;
    const f = join(root, rel);
    const text = readFileSync(f, "utf8");
    if (!originals.has(f)) originals.set(f, text);
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const src = text.replace(/\r\n/g, "\n");
    const froms = Array.isArray(from) ? from : [from], tos = Array.isArray(to) ? to : [to];
    let broken = src, site = 0;
    for (; site < froms.length && broken.split(froms[site]).length === 2; site++) broken = broken.split(froms[site]).join(tos[site]);
    if (site < froms.length) {
      console.log(`CANNOT APPLY   ${what}\n               (the text was not found exactly once in ${rel}: this list is out of date)`);
      bad++;
      continue;
    }
    writeFileSync(f, broken.replace(/\n/g, nl));
    const r = runTours();
    writeFileSync(f, text);
    const failed = out(r).match(/\(fail\) [^\n]*/g) || [];
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
