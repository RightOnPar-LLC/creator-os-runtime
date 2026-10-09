#!/usr/bin/env node
// Do the cancel tests (section 18c of runtime.test.js) really test anything? For each rule that the 2026-10-09
// change put into src/grants.js (and one line each of three files under src/routes) this takes the rule OUT of the source, runs those tests, and expects them to
// FAIL. A rule whose removal nothing notices is a rule with no test. Same method as tours-controls.mjs.
// The last twenty-five are the rules of a refresh token used twice (src/routes/oauth.js): every grant of that client is
// tried even when one cancel fails, the request then fails, the same token used again takes what was left, and
// nothing of another client is touched.
//
//   node test/cancel-controls.mjs        (from the repo root; about a minute)
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
  ["a cancel does not look again for keys issued under a grant while it ran",
    "src/grants.js",
    "          for (let child of late) await cancel(child.id);\n",
    ""],
  ["a cancel does not look under a grant that somebody else ended while it ran",
    "src/grants.js",
    "          // The second look: children issued since the list was read. Nothing can be added under this grant now.\n",
    "          if (!i) return;\n"],
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
  ["the owner's approval runs a request for a key whose grant above has ended",
    "src/routes/grants.js",
    " || (await endedAbove(sql, g.id))) await fail(\"requesting_grant_not_active\");",
    ") await fail(\"requesting_grant_not_active\");"],
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
    "      failed.push({ id, error: String(err?.message || err).slice(0, 200) });\n",
    "      throw err;\n"],
  ["the sweep does not say which candidates it left",
    "src/routes/admin.js",
    "reaped: await reapExpiredGrants({ failed }), failed, tours_ended",
    "reaped: await reapExpiredGrants({ failed }), failed: [], tours_ended"],
  ["the keys under one grant are cancelled in whatever order the database lists them",
    "src/grants.js",
    "SELECT id FROM sub ORDER BY depth DESC, id`;\n        for (let { id } of s) await cancel(id);",
    "SELECT id FROM sub ORDER BY depth DESC`;\n        for (let { id } of s) await cancel(id);"],
  ["a cancel takes the grants by id alone, not the lower ones first",
    "src/grants.js",
    "SELECT id FROM sub ORDER BY depth DESC, id`;\n        for (let { id } of s) await cancel(id);",
    "SELECT id FROM sub ORDER BY id`;\n        for (let { id } of s) await cancel(id);"],
  ["the keys found by a cancel's second look are taken in whatever order the database lists them",
    "src/grants.js",
    "WHERE parent = ${id} AND status = 'active' ORDER BY id`;\n          for (let child of late)",
    "WHERE parent = ${id} AND status = 'active'`;\n          for (let child of late)"],
  ["the admin signs a fresh token for a key whose grant above has ended",
    "src/routes/admin.js",
    " || (await endedAbove(sql, t.id))) throw new HttpError(404, \"grant_not_active\");",
    ") throw new HttpError(404, \"grant_not_active\");"],
  ["an OAuth refresh signs the same grant again although the grant above it has ended",
    "src/routes/oauth.js",
    " && Number(n.exp) - nowSec() > 3600 && !(await endedAbove(sql, n.id))",
    " && Number(n.exp) - nowSec() > 3600"],
  // A refresh token used twice (src/routes/oauth.js): every grant of that client is cancelled, also when one cancel fails.
  ["a refresh token used twice: the first cancel that fails ends the pass, and the grants after it stay live",
    "src/routes/oauth.js",
    "          errors.push(err);\n          failed.push(id);\n",
    "          throw err;\n"],
  ["a refresh token used twice: a pass that left a grant answers as if every grant had been cancelled",
    "src/routes/oauth.js",
    "      if (errors.length) throw errors[0];\n",
    ""],
  ["a refresh token used twice: the request ends with the last failure, not the first",
    "src/routes/oauth.js",
    "      if (errors.length) throw errors[0];\n",
    "      if (errors.length) throw errors[errors.length - 1];\n"],
  ["a refresh token used twice: a record that cannot be written is passed over, and the answer is \"grant revoked\"",
    "src/routes/oauth.js",
    "        } catch (err) {\n          errors.push(err);\n        }\n",
    "        } catch (err) {}\n"],
  ["a refresh token used again does not find a grant an earlier pass left (it goes by the mark on the refresh rows)",
    "src/routes/oauth.js",
    "          SELECT grant_id, tenant FROM marked\n          UNION SELECT r.grant_id, r.tenant FROM oauth_refresh r JOIN grants g ON g.id = r.grant_id WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`,",
    "          SELECT grant_id, tenant FROM marked`,"],
  ["a refresh token used twice leaves a grant the client was moved off earlier (it takes only grants with over an hour left)",
    "src/routes/oauth.js",
    "WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`,",
    "WHERE r.client_id = ${existing.client_id} AND g.status = 'active' AND g.exp > ${nowSec() + 3600}`,"],
  ["a refresh token used again leaves the client's grants in another tenant that an earlier pass left",
    "src/routes/oauth.js",
    "WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`,",
    "WHERE r.client_id = ${existing.client_id} AND r.tenant = ${existing.tenant} AND g.status = 'active'`,"],
  ["a refresh token used again goes over every grant the client ever had, ended ones too",
    "src/routes/oauth.js",
    "WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`,",
    "WHERE r.client_id = ${existing.client_id}`,"],
  ["a refresh token used twice does not go after the grant of a row it marks when that grant has ended (nothing looks under it)",
    "src/routes/oauth.js",
    "          SELECT grant_id, tenant FROM marked\n          UNION SELECT r.grant_id, r.tenant",
    "          SELECT r.grant_id, r.tenant"],
  ["a refresh token used twice does not go after the grant of a row it marks when that grant was cancelled before (run out: yes)",
    "src/routes/oauth.js",
    "          SELECT grant_id, tenant FROM marked\n",
    "          SELECT m.grant_id, m.tenant FROM marked m JOIN grants g ON g.id = m.grant_id WHERE g.status <> 'revoked'\n"],
  ["a refresh token used twice goes after its own grant only when a refresh row still leads to it",
    "src/routes/oauth.js",
    "tenantOf = new Map([[existing.grant_id, existing.tenant], ...found.map(",
    "tenantOf = new Map([...found.map("],
  ["a refresh token used twice ends other clients' grants too (the list is not kept to that client)",
    "src/routes/oauth.js",
    "WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`,",
    "WHERE g.status = 'active'`,"],
  ["a refresh token used twice marks other clients' refresh rows too, and ends their grants",
    "src/routes/oauth.js",
    "WHERE client_id = ${existing.client_id} AND revoked = false RETURNING grant_id, tenant)",
    "WHERE revoked = false RETURNING grant_id, tenant)"],
  ["a refresh token used twice marks the client's refresh rows in its own tenant only (the others still refresh)",
    "src/routes/oauth.js",
    "WHERE client_id = ${existing.client_id} AND revoked = false RETURNING grant_id, tenant)",
    "WHERE client_id = ${existing.client_id} AND tenant = ${existing.tenant} AND revoked = false RETURNING grant_id, tenant)"],
  ["a refresh token used twice: the rows are marked by one statement and the grants listed by another, which can fail on its own",
    "src/routes/oauth.js",
    "      let found = await sql`WITH marked AS (UPDATE oauth_refresh SET revoked = true WHERE client_id = ${existing.client_id} AND revoked = false RETURNING grant_id, tenant)\n          SELECT grant_id, tenant FROM marked\n          UNION SELECT r.grant_id, r.tenant FROM oauth_refresh r JOIN grants g ON g.id = r.grant_id WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`,\n",
    "      let marked = await sql`UPDATE oauth_refresh SET revoked = true WHERE client_id = ${existing.client_id} AND revoked = false RETURNING grant_id, tenant`,\n        found = [...marked, ...(await sql`SELECT r.grant_id, r.tenant FROM oauth_refresh r JOIN grants g ON g.id = r.grant_id WHERE r.client_id = ${existing.client_id} AND g.status = 'active'`)],\n"],
  ["a refresh token used twice: the record does not say which grants were left",
    "src/routes/oauth.js",
    "              failed: own(failed),\n",
    "              failed: [],\n"],
  ["a refresh token used twice: the record does not say which grants were cancelled",
    "src/routes/oauth.js",
    "              cancelled: own(cancelled),\n",
    "              cancelled: [],\n"],
  ["a refresh token used twice: the record, which a tenant's own key can read, names the keys under a grant",
    "src/routes/oauth.js",
    "          if ((await revokeGrantTree(id, \"refresh_token_reuse_detected\", \"oauth\")).includes(id)) cancelled.push(id);\n",
    "          for (let done of await revokeGrantTree(id, \"refresh_token_reuse_detected\", \"oauth\")) (tenantOf.has(done) || tenantOf.set(done, tenantOf.get(id)), cancelled.push(done));\n"],
  ["a refresh token used twice: the record, which a tenant's own key can read, carries the database's words for a failure",
    "src/routes/oauth.js",
    "              failed: own(failed),\n",
    "              failed: own(failed).map((id) => ({ id, error: String(errors[failed.indexOf(id)]?.message) })),\n"],
  ["a refresh token used twice: one tenant's record names the client's grants in every tenant",
    "src/routes/oauth.js",
    "let own = (list) => list.filter((id) => tenantOf.get(id) === tenant);",
    "let own = (list) => list;"],
  ["a refresh token used twice: every tenant's record is filed under the spent token's tenant",
    "src/routes/oauth.js",
    "            tenant,\n            \"oauth\",\n",
    "            existing.tenant,\n            \"oauth\",\n"],
  ["a refresh token used twice: the records are filed under no tenant, where no tenant's key can read them",
    "src/routes/oauth.js",
    "            tenant,\n            \"oauth\",\n",
    "            null,\n            \"oauth\",\n"],
  ["a refresh token used twice: the log does not say that a grant was left",
    "src/routes/oauth.js",
    "      if (failed.length) console.error(`[oauth] refresh token reuse: ",
    "      if (0) console.error(`[oauth] refresh token reuse: "],
  ["a refresh token used twice: the log names only the first grant that was left",
    "src/routes/oauth.js",
    "grants NOT cancelled: ${failed.join(\", \")};",
    "grants NOT cancelled: ${failed[0]};"],
  ["a refresh token used twice: the log carries the failure's words at any length",
    "src/routes/oauth.js",
    "String(errors[0]?.message || errors[0]).slice(0, 200)}`);",
    "String(errors[0]?.message || errors[0])}`);"],
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
