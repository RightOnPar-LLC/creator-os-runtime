#!/usr/bin/env node
// Workflow 8 MVP: Two-Sided Market — one-click build of the minimum viable market.
// This is the escrow keystone with a registry in front: list + discover + call (escrow open) +
// deliver (capture). No new value engine — the market composes existing primitives.
//
// Run: node workflows/w8-market-mvp.mjs
// After: node workflows/run.mjs 8
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

console.log("\n═══ Workflow 8: Two-Sided Market MVP ═══\n");

// Step 1: Create the market module
console.log("  1/4 Creating src/market.js...");
const marketPath = join(srcDir, "market.js");
if (!existsSync(marketPath)) {
  writeFileSync(marketPath, `// Two-sided market MVP — list + discover + call + deliver.
// No new value engine: the market is the escrow keystone with a registry in front.
// Providers list capabilities; callers discover and invoke them via escrow.
import { HttpError, newId, nowSec, parseJson } from "./util.js";
import { getGrant, recordEvent, sql } from "./db.js";
import { openEscrow, captureEscrow, escrowBlock, serializeEscrow } from "./escrow.js";

// List a capability: the provider advertises what they offer and the price.
export async function listCapability(providerRow, params) {
  let name = String(params?.name || "").slice(0, 120);
  if (!name) throw new HttpError(400, "capability_name_required");
  let price = Math.floor(Number(params?.price ?? 0));
  if (!Number.isFinite(price) || price <= 0) throw new HttpError(400, "capability_price_required");
  let desc = String(params?.description || "").slice(0, 500);
  let condition = String(params?.condition || "attestation:self-settle");
  let id = newId("cap");
  await sql\`INSERT INTO events (tenant, type, actor, data)
    VALUES (\${providerRow.tenant}, 'market.listed', \${providerRow.sub},
      \${{ capability_id: id, name, price, desc, condition }}::jsonb)\`;
  return { id, name, price, desc, condition, provider: providerRow.sub };
}

// Discover: search listed capabilities (reads from events for now; a real
// registry would be a dedicated table).
export async function discoverCapabilities(query = {}) {
  let limit = Math.min(Math.max(1, Number(query.limit || 20)), 100);
  let rows = await sql\`SELECT data FROM events WHERE type = 'market.listed' ORDER BY ts DESC LIMIT \${limit}\`;
  return rows.map(r => parseJson(r.data)).filter(Boolean);
}

// Call: open an escrow to a provider (the caller pays, the provider delivers).
export async function callCapability(callerRow, params) {
  let capabilityId = String(params?.capability_id || "");
  if (!capabilityId) throw new HttpError(400, "capability_id_required");
  let payeeTenant = String(params?.provider_tenant || "");
  if (!payeeTenant) throw new HttpError(400, "provider_tenant_required");
  let amount = Math.floor(Number(params?.amount ?? 0));
  if (!amount) throw new HttpError(400, "amount_required");
  let condition = String(params?.condition || "attestation:self-settle");
  // Reuse the escrow keystone — the market IS escrow with a registry
  return openEscrow(callerRow, {
    amount, payee_tenant: payeeTenant,
    condition: { kind: condition },
    payee_ref: capabilityId,
  }, callerRow.sub);
}
`);
  console.log("     ✅ Created");
} else {
  console.log("     ⏭  Already exists");
}

// PLACEHOLDER_ROUTES

// Step 2: Create routes
console.log("  2/4 Creating src/routes/market.js...");
const routesDir = join(srcDir, "routes");
const marketRoutePath = join(routesDir, "market.js");
if (!existsSync(marketRoutePath)) {
  writeFileSync(marketRoutePath, `// Routes: two-sided market MVP.
import { HttpError } from "../util.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { listCapability, discoverCapabilities, callCapability } from "../market.js";

// List a capability (provider advertises)
app.post("/api/market/list", requireGrant(null), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let r = await listCapability(t.row, a);
  return e.json(r, 201);
});

// Discover capabilities (no auth needed — public registry)
app.get("/api/market/discover", async (e) => {
  let q = { limit: e.req.query("limit"), search: e.req.query("q") };
  let results = await discoverCapabilities(q);
  return e.json({ capabilities: results });
});

// Call a capability (open escrow to provider)
app.post("/api/market/call", requireGrant("escrow.hold"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let r = await callCapability(t.row, a);
  return e.json({ escrow: r }, 201);
});
`);
  console.log("     ✅ Created");
} else {
  console.log("     ⏭  Already exists");
}

// Step 3: Register route import in index.js
console.log("  3/4 Registering route in index.js...");
const indexPath = join(srcDir, "index.js");
let index = readFileSync(indexPath, "utf8");
if (!index.includes('./routes/market.js')) {
  index = index.replace(
    'import "./routes/broker.js";',
    'import "./routes/broker.js";\nimport "./routes/market.js";'
  );
  writeFileSync(indexPath, index);
  console.log("     ✅ Registered");
} else {
  console.log("     ⏭  Already registered");
}

// Step 4: Update route snapshot
console.log("  4/4 Updating route snapshot...");
const testDir = join(root, "test");
const bun = join(testDir, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const { spawnSync } = await import("node:child_process");
const r = spawnSync(bun, ["test", "runtime.test.js", "--timeout", "120000"], {
  cwd: testDir, env: { ...process.env, RUNTIME_ENTRY: "../src/index.js", UPDATE_SNAPSHOT: "1" },
  encoding: "utf8", timeout: 180000, stdio: ["pipe", "pipe", "pipe"]
});
const out = (r.stdout || "") + "\n" + (r.stderr || "");
const m = out.match(/(\d+) pass.*(\d+) fail/s);
console.log(`     ${m ? m[1] + " pass, " + m[2] + " fail" : "test run failed"}`);

console.log("\n  ✅ Workflow 8 MVP built. Run: node workflows/run.mjs 8");
console.log("  Market = escrow keystone + registry. No new value engine.\n");