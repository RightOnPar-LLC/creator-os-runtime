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

const bun = join(testModules, "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const arg = process.argv[2];
const env = { ...process.env };
if (arg === "dist") env.RUNTIME_ENTRY = join(root, "dist", "runtime.js");
else if (arg) env.RUNTIME_ENTRY = resolve(root, arg);
const r = spawnSync(bun, ["test", "runtime.test.js", "bridgewire.test.js", "autonomy.test.js"], { cwd: here, env, stdio: "inherit" });
process.exit(r.status ?? 1);
