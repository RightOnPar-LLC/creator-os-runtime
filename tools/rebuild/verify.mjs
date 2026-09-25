#!/usr/bin/env node
// One command that proves the chain live bundle -> readable file -> src/ modules:
// runs passes 1+2 into a temp dir and byte-compares the result with the checked-in
// tools/rebuild/runtime.js, then runs pass 3 (split.mjs --check), which regenerates
// the src/ modules from it and byte-compares them. Exit 0 = identical; 1 = drift.
//   cd tools/rebuild && npm ci && npm run verify
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  const have = readFileSync(join(HERE, "runtime.js"), "utf8").split("\r\n").join("\n");
  if (want !== have) { console.error("DRIFT: tools/rebuild/runtime.js is not the proven rebuild output"); process.exit(1); }
  console.log("tools/rebuild/runtime.js is byte-identical to the proven rebuild of live/runtime-0.3.0.bundle.js");
  // Pass 3 is checked against src/ AS SPLIT (the baseline commit), not the
  // working tree: src/ is now edited on purpose (fixes, features). The proof
  // chain is "live bundle = readable file = src@SPLIT_BASELINE"; everything
  // after that is ordinary reviewed change, visible as `git diff SPLIT_BASELINE -- src`.
  const SPLIT_BASELINE = "526ee25e725ffc258c6e2380e1addf4c10bd4fdc";
  const git = (...a) => spawnSync("git", a, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 << 20 });
  const base = join(tmp, "src-baseline");
  for (const f of git("ls-tree", "-r", "--name-only", SPLIT_BASELINE, "src").stdout.toString().split("\n").filter(Boolean)) {
    const out = join(base, f.slice("src/".length));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, git("show", `${SPLIT_BASELINE}:${f}`).stdout);
  }
  run("split.mjs", join(HERE, "runtime.js"), base, "--check");
  const changed = git("diff", "--stat", SPLIT_BASELINE, "--", "src").stdout.toString().trim();
  console.log(changed ? `src/ changed since the proven split (${SPLIT_BASELINE.slice(0, 7)}) — reviewed changes:\n${changed}` : "src/ is exactly the proven split");
} finally { rmSync(tmp, { recursive: true, force: true }); }
