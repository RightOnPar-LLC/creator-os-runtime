#!/usr/bin/env node
// One command that proves src/runtime.js IS the proven rebuild of the live bundle:
// runs both passes into a temp dir, then byte-compares the result with the
// checked-in file. Exit 0 = identical; 1 = a pass failed or the file drifted.
//   cd tools/rebuild && npm ci && npm run verify
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "runtime-rebuild-"));
const run = (script, ...args) => {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  if (r.status !== 0) { rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
};
try {
  run("format-and-prove.mjs", join(ROOT, "live", "runtime-0.3.0.bundle.js"), join(tmp, "formatted.js"));
  run("rename-and-prove.mjs", join(tmp, "formatted.js"), join(HERE, "rename-map.json"), join(tmp, "readable.js"));
  const want = readFileSync(join(tmp, "readable.js"), "utf8");
  const have = readFileSync(join(ROOT, "src", "runtime.js"), "utf8").split("\r\n").join("\n");
  if (want !== have) { console.error("DRIFT: src/runtime.js is not the proven rebuild output"); process.exit(1); }
  console.log("src/runtime.js is byte-identical to the proven rebuild of live/runtime-0.3.0.bundle.js");
} finally { rmSync(tmp, { recursive: true, force: true }); }
