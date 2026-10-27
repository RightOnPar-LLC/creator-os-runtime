#!/usr/bin/env node
// Runs the characterisation suite with the Bun pinned in test/package.json.
//   node run.mjs                 -> suite against the harness default entry (src/index.js)
//   node run.mjs dist            -> suite against dist/runtime.js (run `node build.mjs` first)
//   node run.mjs src/runtime.js  -> suite against any entry (path relative to the repo root)
//
// src/ and dist/ import "hono" as a bare specifier and the repo root has no install of
// its own (production resolves hono inside Railway's function image). Bun's test runner
// ignores NODE_PATH, so we link <root>/node_modules -> test/node_modules (a directory
// junction on Windows; gitignored). An existing real <root>/node_modules is left alone.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const testModules = join(here, "node_modules");
const rootModules = join(root, "node_modules");
if (!existsSync(testModules)) {
  console.error("test/node_modules missing: run `npm ci` in test/ first");
  process.exit(2);
}
let linked = false;
try { linked = lstatSync(rootModules).isSymbolicLink(); } catch {}
if (!existsSync(rootModules)) symlinkSync(testModules, rootModules, "junction");
else if (!linked) console.warn("note: using the existing real node_modules at the repo root");

// npm's bun package ships its binary as bin/bun.exe on every platform (a Linux ELF
// under that name, too), so look for either name rather than assuming by OS.
const bunDir = join(testModules, "bun", "bin");
const bun = ["bun.exe", "bun"].map((n) => join(bunDir, n)).find((p) => existsSync(p)) || join(bunDir, "bun");
const arg = process.argv[2];
const env = { ...process.env };
if (arg === "dist") env.RUNTIME_ENTRY = join(root, "dist", "runtime.js");
else if (arg) env.RUNTIME_ENTRY = resolve(root, arg);
// The per-test time limit has to be given HERE. This bun reads [test] in bunfig.toml but ignores a
// `timeout` key there: from 2026-09-25 bunfig said 30 s and every test ran with bun's own 5 s.
const r = spawnSync(bun, ["test", "--timeout", "30000", "runtime.test.js", "bridgewire.test.js", "autonomy.test.js", "hostpolicy.test.js", "bus.test.js"], { cwd: here, env, stdio: "inherit" });
process.exit(r.status ?? 1);
