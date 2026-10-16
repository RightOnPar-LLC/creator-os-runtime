#!/usr/bin/env node
// Workflow runner — one-click execution for each of the 8 agent economic layer
// workflows. Run a single workflow:   node workflows/run.mjs 4
// Run all:                            node workflows/run.mjs all
// Run and auto-fix (build if needed): node workflows/run.mjs 7 --build
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const testDir = join(root, "test");
const bun = join(testDir, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const arg = process.argv[2];
const doBuild = process.argv.includes("--build");

function runTest() {
  const args = ["test", "runtime.test.js", "--timeout", "120000"];
  const r = spawnSync(bun, args, { cwd: testDir, env: { ...process.env, RUNTIME_ENTRY: "../src/index.js" }, encoding: "utf8", timeout: 180000, stdio: ["pipe", "pipe", "pipe"] });
  // bun test writes results to stderr
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  const pass = out.match(/(\d+) pass/);
  const fail = out.match(/(\d+) fail/);
  const total = pass ? Number(pass[1]) : 0;
  const fails = fail ? Number(fail[1]) : 0;
  return { ok: r.status === 0 && fails === 0, total, fails, out };
}

function check(label, pattern, result) {
  const has = result.out.includes(pattern);
  return { ok: result.ok && has, msg: has ? `${label}: ✅ PASS` : `${label}: ❌ pattern "${pattern}" not found` };
}

// Run the full suite ONCE, then check each workflow's pattern against the output
console.log(`\n${"═".repeat(60)}`);
console.log(`  AGENT ECONOMIC LAYER — Workflow Runner`);
console.log(`${"═".repeat(60)}`);
console.log(`  Running full test suite once...\n`);

const suite = runTest();
console.log(`  Suite: ${suite.total} pass, ${suite.fails} fail\n`);

const workflows = {
  1: { name: "Grant Engine", desc: "The atom", blocks: "3-8", status: "DONE",
    run() { return check("Grant Engine", "8. extras: grants", suite); } },
  2: { name: "Guest Welcome", desc: "Keyless onboarding", blocks: "12-18", status: "DONE",
    run() { return check("Guest Welcome", "12. guest-welcome", suite); } },
  3: { name: "Reservation Reaper", desc: "Grant expiry", blocks: "reaper", status: "DONE",
    run() { return check("Reservation Reaper", "reservation reaper", suite); } },
  4: { name: "Escrow Keystone", desc: "HOLD + CAPTURE", blocks: "19,21,21b", status: "DONE",
    run() { return check("Escrow Keystone", "19. escrow keystone", suite); } },
  5: { name: "Autonomy Dial", desc: "Per-grant authority", blocks: "22", status: "DONE",
    run() { return check("Autonomy Dial", "22. the autonomy dial", suite); } },
  6: { name: "Agent Host", desc: "Sub-agent hiring", blocks: "23", status: "DONE",
    run() { return check("Agent Host", "23. agent-host", suite); } },
  7: { name: "Repo Broker", desc: "Credential delegation", blocks: "24", status: "BUILT",
    run() {
      const broker = join(root, "src", "broker.js");
      const route = join(root, "src", "routes", "broker.js");
      if (!existsSync(broker)) return { ok: false, msg: "Repo Broker: ❌ src/broker.js missing" };
      if (!existsSync(route)) return { ok: false, msg: "Repo Broker: ❌ src/routes/broker.js missing" };
      return { ok: suite.ok, msg: `Repo Broker: ✅ BUILT (broker.js + routes, ${suite.ok ? "suite green" : "suite has failures"})` };
    }
  },
  8: { name: "Two-Sided Market", desc: "List + discover + call + deliver", blocks: "25-27", status: "BUILT",
    run() {
      const market = join(root, "src", "market.js");
      const route = join(root, "src", "routes", "market.js");
      if (!existsSync(market)) return { ok: false, msg: "Two-Sided Market: ❌ src/market.js missing" };
      if (!existsSync(route)) return { ok: false, msg: "Two-Sided Market: ❌ src/routes/market.js missing" };
      return { ok: suite.ok, msg: `Two-Sided Market: ✅ BUILT (market.js + routes, ${suite.ok ? "suite green" : "suite has failures"})` };
    }
  },
};

// Main execution
const target = arg || "all";
const ids = target === "all" ? Object.keys(workflows) : [target];

let passed = 0, failed = 0, skipped = 0;

for (const id of ids) {
  const w = workflows[id];
  if (!w) { console.log(`  ❌ Unknown workflow: ${id}`); failed++; continue; }
  console.log(`  ▸ Workflow ${id}: ${w.name}`);
  console.log(`    ${w.desc} · Blocks: ${w.blocks} · Status: ${w.status}`);

  if (w.status === "NOT BUILT" && !doBuild) {
    console.log(`    ⏭  SKIPPED (not built, use --build to auto-build)\n`);
    skipped++;
    continue;
  }

  const r = w.run();
  console.log(`    ${r.msg}\n`);
  if (r.ok) passed++; else failed++;
}

console.log(`${"═".repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) process.exit(1);
if (passed === 0 && skipped > 0) {
  console.log("  To build unbuilt workflows:");
  console.log("    node workflows/w7-repo-broker.mjs");
  console.log("    node workflows/w8-market-mvp.mjs");
  console.log("  Then re-run: node workflows/run.mjs all\n");
}