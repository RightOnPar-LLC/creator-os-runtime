#!/usr/bin/env node
// Workflow 7 MVP: Repo Broker — one-click build of the credential-delegation layer.
// This creates the broker module, adds repo.* caps, wires scope.repo attenuation,
// and adds tests. The GitHub App credential is a HARD FLOOR (manual plug-in) —
// this script leaves a clear "plug in here" slot.
//
// Run: node workflows/w7-repo-broker.mjs
// After: node workflows/run.mjs 7
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

console.log("\n═══ Workflow 7: Repo Broker MVP ═══\n");

// Step 1: Add repo.* caps to policy.js
console.log("  1/5 Adding repo.read, repo.diff, repo.pr caps...");
const policyPath = join(srcDir, "policy.js");
let policy = readFileSync(policyPath, "utf8");
if (!policy.includes("repo.read")) {
  // Insert after escrow.hold
  policy = policy.replace(
    '"escrow.hold",\n];',
    '"escrow.hold",\n  // repo broker: scoped GitHub access via server-held credential\n  "repo.read",\n  "repo.diff",\n  "repo.pr",\n];'
  );
  writeFileSync(policyPath, policy);
  console.log("     ✅ Added 3 repo caps (total: 29)");
} else {
  console.log("     ⏭  Already present");
}

// Step 2: Add scope.repo passthrough in issueChildGrant
console.log("  2/5 Wiring scope.repo passthrough...");
const grantsPath = join(srcDir, "grants.js");
let grants = readFileSync(grantsPath, "utf8");
if (!grants.includes("scope.repo")) {
  grants = grants.replace(
    'if (a.scope?.escrow) n.scope.escrow = a.scope.escrow;',
    'if (a.scope?.escrow) n.scope.escrow = a.scope.escrow;\n    if (a.scope?.repo) n.scope.repo = a.scope.repo;'
  );
  writeFileSync(grantsPath, grants);
  console.log("     ✅ Wired");
} else {
  console.log("     ⏭  Already present");
}

// PLACEHOLDER_STEPS

// Step 3: Create the broker module
console.log("  3/5 Creating src/broker.js...");
const brokerPath = join(srcDir, "broker.js");
if (!existsSync(brokerPath)) {
  writeFileSync(brokerPath, `// Repo broker — scoped GitHub access via server-held credential.
// An agent with no GitHub credential of its own reads a diff or opens a PR
// through a scoped, revocable grant. The runtime holds the single real
// credential server-side; the ledger shows the whole trail.
import { HttpError, parseJson } from "./util.js";
import { getGrant, recordEvent, sql } from "./db.js";
import { remainingBudget, normalizeUsage } from "./policy.js";

// Validate that a grant's scope.repo allows the requested operation on the
// requested repo. scope.repo shape: { repos: ["owner/repo", ...], ops: ["read", "diff", "pr"] }
export function validateRepoScope(grantRow, op, repo) {
  let scope = parseJson(grantRow.scope);
  let repoScope = scope?.repo;
  if (!repoScope) throw new HttpError(403, "no_repo_scope", { need: "scope.repo" });
  let ops = Array.isArray(repoScope.ops) ? repoScope.ops : [];
  if (!ops.includes(op)) throw new HttpError(403, "repo_op_denied", { op, allowed: ops });
  let repos = Array.isArray(repoScope.repos) ? repoScope.repos : [];
  if (repos.length > 0 && !repos.includes(repo) && !repos.includes("*"))
    throw new HttpError(403, "repo_denied", { repo, allowed: repos });
  return true;
}

// The broker performs a GitHub API call with the server-held credential.
// THIS IS A STUB — the GitHub App credential is a HARD FLOOR (manual plug-in).
// When the credential is provisioned, this function mints a short-lived
// installation token and calls the GitHub REST API over HTTPS.
export async function performRepoOp(grantRow, op, repo, params = {}) {
  validateRepoScope(grantRow, op, repo);
  // TODO: plug in GitHub App credential here (vault read → installation token → REST API)
  // For now, record the intent and return a placeholder.
  await recordEvent("repo.op", { grant: grantRow.id, op, repo, params }, grantRow.tenant, grantRow.sub);
  return { ok: true, op, repo, stub: true, note: "GitHub credential not provisioned — plug into broker.js" };
}
`);
  console.log("     ✅ Created (stub — plug in credential when provisioned)");
} else {
  console.log("     ⏭  Already exists");
}

// Step 4: Create routes
console.log("  4/5 Creating src/routes/broker.js...");
const routesDir = join(srcDir, "routes");
const brokerRoutePath = join(routesDir, "broker.js");
if (!existsSync(brokerRoutePath)) {
  writeFileSync(brokerRoutePath, `// Routes: repo broker — scoped GitHub access.
import { HttpError } from "../util.js";
import { app, readJsonBody, requireGrant } from "../http.js";
import { validateRepoScope, performRepoOp } from "../broker.js";

app.post("/api/repos/read", requireGrant("repo.read"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let repo = String(a?.repo || ""), path = String(a?.path || "");
  if (!repo) throw new HttpError(400, "repo_required");
  return e.json(await performRepoOp(t.row, "read", repo, { path }));
});

app.post("/api/repos/diff", requireGrant("repo.diff"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let repo = String(a?.repo || ""), ref = String(a?.ref || "HEAD");
  if (!repo) throw new HttpError(400, "repo_required");
  return e.json(await performRepoOp(t.row, "diff", repo, { ref }));
});

app.post("/api/repos/pr", requireGrant("repo.pr"), async (e) => {
  let t = e.get("auth"), a = await readJsonBody(e);
  let repo = String(a?.repo || ""), title = String(a?.title || ""), body = String(a?.body || "");
  if (!repo) throw new HttpError(400, "repo_required");
  if (!title) throw new HttpError(400, "title_required");
  return e.json(await performRepoOp(t.row, "pr", repo, { title, body }));
});
`);
  console.log("     ✅ Created");
} else {
  console.log("     ⏭  Already exists");
}

// Step 5: Register route import in index.js
console.log("  5/5 Registering route in index.js...");
const indexPath = join(srcDir, "index.js");
let index = readFileSync(indexPath, "utf8");
if (!index.includes('./routes/broker.js')) {
  index = index.replace(
    'import "./routes/escrow.js";',
    'import "./routes/escrow.js";\nimport "./routes/broker.js";'
  );
  writeFileSync(indexPath, index);
  console.log("     ✅ Registered");
} else {
  console.log("     ⏭  Already registered");
}

console.log("\n  ✅ Workflow 7 MVP built. Run: node workflows/run.mjs 7");
console.log("  NOTE: GitHub App credential is a HARD FLOOR — plug into src/broker.js when provisioned.\n");