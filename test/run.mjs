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
//
// Each suite file runs in its OWN bun process: harness.js boots one runtime + one
// throwaway Postgres per process and each file shuts it down in afterAll.
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

const bunBin = join(testModules, "bun", "bin");
const bun = process.platform === "win32"
  ? join(bunBin, "bun.exe")
  : existsSync(join(bunBin, "bun"))
    ? join(bunBin, "bun")
    : join(bunBin, "bun.exe");
const arg = process.argv[2];
const env = { ...process.env };
if (arg === "dist") env.RUNTIME_ENTRY = join(root, "dist", "runtime.js");
else if (arg) env.RUNTIME_ENTRY = resolve(root, arg);
let status = 0;
for (const file of ["runtime.test.js", "connector-exec.test.js"]) {
  const r = spawnSync(bun, ["test", `./${file}`], { cwd: here, env, stdio: "inherit" });
  if ((r.status ?? 1) !== 0) status = r.status ?? 1;
}
process.exit(status);
