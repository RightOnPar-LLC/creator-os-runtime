#!/usr/bin/env node
// Deliberately break the mechanism, require assertion failures, restore bytes.
// The suite boots only its own throwaway database and blocks outbound network.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const bun = ["bun.exe", "bun"].map(n => join(here, "node_modules/bun/bin", n)).find(existsSync);
if (!bun) throw new Error("pinned test Bun missing");
const controls = [
  ["missing MCP boundary", "src/routes/mcp.js", 'app.use("/mcp", toolReceiptMiddleware(MCP_TOOLS.map((t) => t.name)));', "// boundary removed by negative control"],
  ["false success", "src/tool-receipts.js", 'const result = receiptOutcome(c.res.status, body, c.get("toolReceiptErrorStatus") ?? c.res.status);', 'const result = { outcome: "succeeded", reason: null };'],
  ["sibling receipt leak", "src/tool-receipts.js", 'AND grant_id IN (SELECT id FROM sub)', 'AND true'],
];
for (const [name, file, before, after] of controls) {
  const path = join(root, file), original = readFileSync(path, "utf8");
  if (original.split(before).length !== 2) throw new Error(`${name}: control anchor moved`);
  let r;
  try {
    writeFileSync(path, original.replace(before, after));
    r = spawnSync(bun, ["test", "--timeout", "30000", "--test-name-pattern", "tool invocation receipts", "runtime.test.js"], { cwd: here, encoding: "utf8", timeout: 120000 });
  } finally { writeFileSync(path, original); }
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.error || r.status === 0 || !out.includes("(fail)") || out.includes("Unhandled error between tests"))
    throw new Error(`${name}: did not produce a real assertion failure (exit ${r.status})`);
  console.log(`CONTROL PASS: ${name} is caught by assertions`);
}
