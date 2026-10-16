// Repo broker — scoped GitHub access via server-held credential.
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
