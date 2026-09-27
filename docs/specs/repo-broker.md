# Grant-based repo broker — spec against the current grant model

**Status:** design · **Owner:** creator-os-runtime (mainstream lane) · **As of:** 2026-09-27
**Source:** Inter-agent autonomy plan (2026-09-27), Phase 3 — "the moat / haven version."
**Goal:** an agent with **no GitHub credential of its own** reads a diff or opens a PR through a
scoped, revocable grant; the runtime holds the single real credential server-side; the ledger
shows the whole trail. No raw keys pass between agents; no human copy-pastes diffs.

## The one-line shape

This is the escrow pattern again: **reuse the grant engine, add one scope block + a few caps +
a broker that performs the side effect.** A repo grant is an ordinary attenuated grant carrying
`repo.*` caps and a `scope.repo` block; three MCP tools (`repo_read`, `repo_diff`, `repo_pr`)
verify the grant, perform the GitHub op with a server-held credential the agent never sees, and
write a ledger row. Per-task issuance, revocation, TTL-expiry, and audit all fall out of the
existing model for free.

## What the current model already gives us (measured, `src/`)

- **Attenuated grants** — `issueChildGrant` clamps caps/scope/budget/ttl to the parent; a child
  can only ever narrow. `scope.repo` attenuates exactly like `scope.railway.projects` and
  `scope.memory.partitions` do today.
- **Capability gate** — routes and MCP tools gate on caps (`requireGrant("...")`, the MCP cap map).
  Adding `repo.read` / `repo.diff` / `repo.pr` mirrors the source-aware `code.write` / `lsp.*` caps.
- **Ledger** — every op already writes `tenant, grant_id, parent, kind, ref, note`. A `repo-*`
  ledger row per operation **is** the audit trail the plan asks for, with no new table.
- **Revocation + expiry** — `revokeGrantTree` and the reaper give "issued per task and revocable"
  for free: a task grant is revoked when the task ends, or auto-expires at its TTL.
- **Vault** — AES-GCM secret storage exists (`vault` table) for the server-held credential.

**The gap (must be provisioned):** the runtime's **only** GitHub credential today is
`GITHUB_WEBHOOK_SECRET` — an *inbound* webhook HMAC, **not** an outbound API credential. `armed
github:true` means "can receive GitHub webhooks," not "can call GitHub." Phase 3 needs a **new
server-side credential** (below). This is a Lisa/DW provisioning step (a hard-floor credential),
not something the agent or this spec can create.

## The credential — a GitHub App installation token (recommended)

Hold a **GitHub App** (the plan notes the "Claude Github MCP Connector" App is already installed on
the repos), not a deploy key or a PAT:

- Store the App's **private key + app id + installation id** in the vault (server-side, never in a
  grant, card, ledger note, or any response).
- The broker mints a **short-lived installation token** (~1h, refreshed on demand) per operation
  batch, scoped by GitHub to the installed repos, and calls the REST API over HTTPS (no SSH egress
  — the blocker that stops the cloud the_steele_zone VM never applies to a server-side HTTPS call).
- Uninstalling the App or rotating the key revokes everything at the GitHub layer; grant revocation
  revokes at our layer. Two independent kill switches.

Why not a deploy key: SSH-only, per-repo key sprawl, no fine-grained op scoping, and it cannot open
PRs via API cleanly. Why not a PAT: coarse, long-lived, tied to a human.

## The repo grant (the new object, minimally)

Add caps and one scope block; reuse everything else.

- **Caps** (add to `CAPS`, mirroring `lsp.*`): `repo.read`, `repo.diff`, `repo.pr`.
- **Scope** — `scope.repo`:
  ```json
  {
    "repos": ["creator-os-runtime"],
    "ops": ["read", "diff", "pr"],
    "branches": ["*"]
  }
  ```
- **Attenuation** — add to `attenuationViolations`, same shape as railway/memory:
  `scope_repo_repos_widened` (child `repos` ⊄ parent `repos`), `scope_repo_ops_widened`,
  `scope_repo_branches_widened`. A child can only narrow the repo set, the op set, the branches.
- Per-task issuance + TTL + revoke are the existing lifecycle — nothing new.

## The three broker operations (MCP tools + REST)

Each: verify grant → check `repo.<op>` cap → check `scope.repo` covers the target repo (and branch
where relevant) → perform via the installation token → write a ledger row → return the result.
The agent never receives the token.

| Tool | Cap | Does | Side effect | Floor |
|---|---|---|---|---|
| `repo_read` | `repo.read` | Return a file's contents at a ref | none (read) | auto |
| `repo_diff` | `repo.diff` | Return a branch/PR/commit-range diff | none (read) | auto |
| `repo_pr` | `repo.pr` | Open a **draft** PR (title, head, base, body) | creates a PR on our own repo | auto (our org); see below |

- `repo_pr` **opens, never merges.** There is no merge operation in the broker. Merging an
  auto-deploy repo stays a **human/senior-gate hard floor** — the plan's standing guardrail.
  Opening a draft PR against our own org is the autopush lane (not a hard floor), so `repo_pr` is
  auto; it is still ledgered and scope-checked.
- Reads are subtree-scoped to what the grant's `scope.repo.repos` allows — an agent cannot read a
  repo outside its grant, ever.

## Ledger + audit

New ledger kinds (kept distinct so the repo trail is queryable on its own): `repo-read`,
`repo-diff`, `repo-pr`. Each row carries `grant_id`, the repo, and the ref/branch/PR in `ref`/`note`
— "which agent touched what," provable by both sides, no new table.

## API / MCP surface

- MCP: `repo_read { repo, path, ref? }`, `repo_diff { repo, base, head }`, `repo_pr { repo, head, base, title, body }`.
- REST mirror (optional, later): `GET /api/repo/:repo/file`, `GET /api/repo/:repo/diff`, `POST /api/repo/:repo/pr`.
- Register `repo_read/diff/pr` in `MCP_TOOLS` — which means they **auto-appear as skills on the A2A
  agent card** (#26), so the delegation Phase 2 wants is discoverable with no extra work.

## How the plan's flow works on this

The cloud `the_steele_zone` agent (SSH-blocked, no repo clone) holds a `repo.read`+`repo.diff`
grant scoped to `creator-os-runtime`. It calls `repo_diff` over MCP, the runtime performs the
GitHub diff with its installation token, returns the diff, and writes a `repo-diff` ledger row.
**Zero raw keys, zero Lisa copy-paste, full audit** — the Phase 2 "done when" met through Phase 3
plumbing.

## Negative controls (red-before-green — write and prove red BEFORE any green)

1. **No op without the cap** — a grant lacking `repo.read` → `repo_read` is refused (403/unknown_tool).
2. **Scope is enforced** — a `repo.read` grant scoped to repo A cannot read repo B → 403 `out_of_scope`.
3. **Attenuation** — a child grant cannot widen `repos`/`ops`/`branches` beyond its parent → `attenuation_violation`.
4. **No merge path** — the broker exposes no merge; `repo_pr` opens a draft PR only. (Assert the tool set contains no merge op.)
5. **Credential never leaks** — the installation token / App key appears in no grant, no card, no ledger note, no tool response (scan the responses).
6. **Every op is ledgered** — `repo_read`/`repo_diff`/`repo_pr` each append exactly one `repo-*` row naming the grant + repo.
7. **Revocation bites** — a revoked (or expired) grant's next repo op → 401.

Each control proven to fail with its guard removed, then pass with it; both git and cognitive-mcp
record the outcome (Law 5). The GitHub-calling paths are stubbed/mocked in the test harness (no live
GitHub in CI) — the broker takes an injectable GitHub client so the tests drive it deterministically.

## Build order (smallest shippable first)

1. **Caps + `scope.repo` + attenuation** (`policy.js`), and the credential-provisioning contract
   (Lisa provisions the GitHub App key/installation id into the vault). No GitHub calls yet.
2. **`repo_read` + `repo_diff`** (read-only) over an injectable GitHub client + ledger + controls 1–3, 5–7.
3. **`repo_pr`** (open draft PR, never merge) + control 4.
4. **Card tie-in** — the three tools land in `MCP_TOOLS`, so they self-advertise on the A2A card (Phase 2 delegation).

## Guardrails (from the plan, restated as hard rules)

- Never expose the server-held GitHub credential to any agent, in any surface.
- `repo_pr` opens; **merge to an auto-deploy repo stays a human/senior-gate hard floor.**
- No real-money or production-credential edges without the lawyer's sign-off (standing constraint).
- One canonical GitHub App credential, server-side; grant revocation and App uninstall are the two kill switches.

## Why this is the moat

Every other network hands agents raw tokens or makes a human broker access. Here an agent with **no
credential of its own** does real repo work through a scoped, revocable, fully-audited grant — the
runtime's existing trust story extended one surface. It reuses the grant engine, the ledger, the
vault, and the A2A card, and adds only a scope block, three caps, and a broker.
