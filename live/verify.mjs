#!/usr/bin/env node
/**
 * Does the live runtime still run the code in this folder?
 *
 * The runtime reports the sha256 of its own source at /health. This compares it
 * with the newest live/runtime-*.bundle.js here. Exit 0 = same bytes, 1 = drift
 * (live changed and git did not follow — pull it again), 2 = could not check.
 *
 *   node live/verify.mjs [--url https://runtime-production-9d95.up.railway.app]
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--url");
const URL_ = (i > 0 ? process.argv[i + 1] : null) ?? "https://runtime-production-9d95.up.railway.app";

const bundles = readdirSync(HERE).filter((f) => /^runtime-.*\.bundle\.js$/.test(f)).sort();
if (!bundles.length) { console.error("no live/runtime-*.bundle.js to compare"); process.exit(2); }
const file = bundles.at(-1);
const local = createHash("sha256").update(readFileSync(join(HERE, file))).digest("hex");

let health;
try {
  const r = await fetch(`${URL_}/health`, { signal: AbortSignal.timeout(10_000) });
  health = await r.json();
} catch (e) { console.error(`could not read ${URL_}/health: ${e.message}`); process.exit(2); }

const live = health?.source?.sha256;
if (!live) { console.error("live /health reports no source.sha256"); process.exit(2); }
if (live === local) { console.log(`IN SYNC  ${file}  v${health.version}  sha256 ${local.slice(0, 12)}`); process.exit(0); }
console.log(`DRIFT  live v${health.version} sha256 ${live.slice(0, 12)} ≠ ${file} ${local.slice(0, 12)}`);
console.log("Pull the running code again (Railway get-function-source-code → deployedCode) and commit it here.");
process.exit(1);
