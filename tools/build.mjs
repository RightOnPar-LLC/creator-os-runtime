#!/usr/bin/env node
// Builds the production artifact: ONE file, dist/runtime.js, from src/index.js.
// Production is a Railway Bun *function* (a single file), so the split modules are
// bundled back together here. Flags mirror the live 0.3.0 bundle: target bun,
// minified, and "hono" left external (the function image resolves it at boot).
// Uses the Bun pinned in test/package.json (run `npm ci` in test/ first).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bun = join(root, "test", "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
if (!existsSync(bun)) {
  console.error("pinned bun missing: run `npm ci` in test/ first");
  process.exit(2);
}
const args = ["build", "src/index.js", "--target=bun", "--external", "hono", "--minify", "--outfile", "dist/runtime.js"];
if (process.argv.includes("--no-minify")) args.splice(args.indexOf("--minify"), 1);
const r = spawnSync(bun, args, { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
