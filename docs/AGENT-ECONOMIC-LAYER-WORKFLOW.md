# Agent Economic Layer — Master Workflow Index

**The full path from one grant to a two-sided market, across both systems.**
**Owner:** creator-os-runtime (mainstream) · steele-os (adult) · **As of:** 2026-09-29

---

## How to read this document

There are **8 workflows**, ordered smallest → biggest. Each one builds on the
previous. Every workflow has:
- **What it is** (one paragraph)
- **What already exists** (code, tests, PRs)
- **What to build** (step-by-step, numbered)
- **How to verify** (tests to run, green criteria)
- **Where it lives** (repo, branch, file)

The **Index at the top** is your map. The **Index at the bottom** is your
checklist. Start at Workflow 1. Don't skip.

---

## INDEX — 8 Workflows (smallest → biggest)

| # | Workflow | Status | System | Depends on |
|---|----------|--------|--------|------------|
| 1 | **Grant Engine** — the atom | ✅ LIVE | mainstream | — |
| 2 | **Guest Welcome** — keyless onboarding | ✅ MERGED (#23) | mainstream | 1 |
| 3 | **Reservation Reaper** — grant expiry + deadlock fix | ✅ MERGED (#24) | mainstream | 1 |
| 4 | **Escrow Keystone** — HOLD + CAPTURE value movement | ✅ MERGED (#25,#28) + `claude/escrow-self-settle` | mainstream | 1, 3 |
| 5 | **Autonomy Dial** — per-grant authority + approvals | ✅ MERGED (#29) | mainstream | 1 |
| 6 | **Agent Host** — sub-agent hiring + ceilings | ✅ MERGED (#30) | mainstream | 1, 5 |
| 7 | **Repo Broker** — inter-agent credential delegation | 📋 SPEC ONLY | mainstream | 1, 4, 6 |
| 8 | **Two-Sided Market** — the composition of everything | 📋 NEXT | both | 1–7 |

**Adult side (steele-os) parallel track:**

| # | Workflow | Status | System |
|---|----------|--------|--------|
| A1 | **Store Foundation** — clip pricing, phantom detection, verifier | ✅ LIVE | adult |
| A2 | **ROG Go-Live** — daemons, poster relay, watcher | ✅ LIVE | adult |
| A3 | **Show Bridge** — OBS ↔ steele-os show control | 🔨 IN PROGRESS | adult |
| A4 | **Flywheel** — automated tick, shelf clean, settlement | 🔄 ONGOING | adult |

---

---

## WORKFLOW 1: Grant Engine — the atom

### What it is
Everything in the agent economic layer is a grant. A grant is a signed,
attenuated capability token: it has caps (what you can do), scope (where you
can do it), budget (how much you can spend), and an expiry (when you stop).
The engine mints root grants for tenants, issues attenuated children, verifies
presented tokens, and settles usage. This is the atom — every other workflow
is a grant with a different scope block.

### What already exists
- `src/grants.js` — mintRootGrant, issueChildGrant, revokeGrantTree, settleGrantUsage, verifyGrant
- `src/policy.js` — 26 caps, 5 tiers, usage arithmetic, attenuation rules
- `src/db.js` — grants table (id, tenant, parent, caps, scope, budget, reserved, settled, exp)
- `src/tokens.js` — grant token signing + verification (HMAC-SHA256)

### Steps to build
1. Define grants table schema
2. Implement `mintRootGrant(tenant)` — full caps, tier budget
3. Implement `issueChildGrant(parent, spec)` — attenuate caps, budget, depth
4. Implement `verifyGrant(token, cap?, scope?)` — parse, check exp/status/cap/scope
5. Implement `settleGrantUsage(grantId, usage)` — settled += usage
6. Implement `revokeGrantTree(grantId)` — cascade, return unspent to parent
7. Wire routes: POST /api/grants, GET /api/grants/verify, POST /api/grants/settle
8. Tests: attenuation, budget exhaustion, revocation cascade

### How to verify
`cd test && bun test runtime.test.js` — blocks 3–6 must pass.

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: `master` · Files: `src/grants.js`, `src/policy.js`

---

## WORKFLOW 2: Guest Welcome — keyless onboarding

### What it is
A visitor with no identity gets a guest grant: attenuated below starter (one
worker, 3 probe deploys, house-credit budget, depth 1). Sybil defence:
per-fingerprint one active guest, rate-limited mints. Pool circuit breaker:
pauses issuance when nearly drained. Brain-sync quarantine: guest memories
isolated.

### What already exists
- PR #23 merged (`752297a`) · `src/guest.js` · 107/107 green

### Steps to build
1. Define `guest` tier in TIERS
2. Fingerprint-based sybil defence (salt + HMAC)
3. Guest pool + circuit breaker
4. Keyless MCP gate (limited tool set)
5. Brain-sync quarantine
6. Wire `POST /api/guest/welcome`
7. Tests: sybil blocked, pool exhaustion, quarantine isolation

### How to verify
`cd test && bun test runtime.test.js` — block 12 must pass.

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: `master` · Files: `src/guest.js`, `src/routes/guest.js`

---

## WORKFLOW 3: Reservation Reaper — grant expiry

### What it is
When a grant expires, its reserved budget returns to the parent. The reaper
sweeps expired grants on a timer, releasing each one's unspent reservation.
Deadlock fix: per-grant transactions (lock order: child then parent).

### What already exists
- PR #24 merged (`d3a1c9a`) · `releaseExpiredGrant`, `reapExpiredGrants` · 69/69 green

### Steps to build
1. `releaseExpiredGrant(tx, grant)` — RETURNING-id flip guard (idempotent)
2. `reapExpiredGrants()` — sweep all expired, one txn per grant
3. Background timer (REAP_INTERVAL_MS, unref'd)
4. POST /api/admin/grants/reap (manual trigger)
5. Tests: expiry releases budget, idempotent re-release

### How to verify
`cd test && bun test runtime.test.js` — blocks 7–8 must pass.

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: `master` · Files: `src/grants.js`, `src/index.js`

---

## WORKFLOW 4: Escrow Keystone — HOLD + CAPTURE value movement

### What it is
Two of escrow's three states already exist: HOLD = reserve (issuing a
custodian child), REFUND = release (reaper/revoke). The one new primitive
is CAPTURE — resolving held value to a DIFFERENT party on a verified
condition. Two condition kinds: `attestation:self-settle` (payee attests
delivery) and `receipt:mesh` (signed MeshMarket receipt via webhook).

### What already exists
- PR #25 merged (spec + open + read) · PR #28 merged (receipt:mesh capture)
- Branch `claude/escrow-self-settle` pushed (attestation:self-settle capture)
- `src/escrow.js` — buildEscrow, openEscrow, captureEscrow, captureFromSelfSettle, captureFromMeshReceipt
- `src/routes/escrow.js` — POST /api/escrow, GET /api/escrow/:id, POST /api/escrow/:id/capture
- `src/routes/webhooks.js` — POST /webhooks/mesh (receipt:mesh capture path)
- `docs/specs/escrow-keystone.md` — full spec
- 196/196 green, senior-gate double-loop 0 findings

### Steps to build
1. Add `escrow.hold` cap to CAPS
2. Add `scope.escrow` passthrough in issueChildGrant
3. `buildEscrow(payerRow, params)` — validate + shape custodian child
4. `openEscrow(payerRow, params, issuedBy)` — issue custodian child (HOLD)
5. Read helpers: escrowBlock, escrowState, serializeEscrow
6. `findEscrowGrant(idOrEscrowId)` — resolve gr_ or es_ id
7. `captureEscrow(id, { source, ref })` — atomic: active→captured, reserved→settled, ledger rows
8. `captureFromSelfSettle(callerRow, escrowId)` — condition + tenant check
9. `captureFromMeshReceipt(receipt)` — condition + ref + payee check
10. Open + read routes, self-settle capture route
11. Webhook capture path (gated behind escrow_capture + kill switch)
12. 9+ tests: open, hold, refund, self-settle, receipt, double-capture, mutual exclusion, gates

### How to verify
`cd test && bun test runtime.test.js` — blocks 19, 21, 21b must pass.

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: `master` (stages 1+2), `claude/escrow-self-settle` (pending)

---

## WORKFLOW 5: Autonomy Dial — per-grant authority

### What it is
Every grant carries an autonomy level: `observe` (read-only), `ask` (value
actions wait for human), `act` (auto-execute). A child can never outrank
its parent. At `ask`, the owner's root grant approves or denies.

### What already exists
- PR #29 merged · `src/autonomy.js` · `src/db.js` (approvals table) · 22 tests passing

### Steps to build
1. Define AUTONOMY_LEVELS: observe (0), ask (1), act (2)
2. `autonomyOf(constraints)` — read dial from grant
3. `decide(level, action)` — return refuse/ask/act
4. Ledger columns (autonomy, decision, approver)
5. Approvals table (id, tenant, grant_id, action, intent, status, approver)
6. POST /api/approvals/:id (approve/deny, owner only)
7. Autonomy check in value-action routes
8. Tests: dial inheritance, widening refused, ask blocks, owner-only approve

### How to verify
`cd test && bun test runtime.test.js` — block 22 must pass.

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: `master` · Files: `src/autonomy.js`

---

## WORKFLOW 6: Agent Host — sub-agent hiring

### What it is
An agent gets its own machine and a budget. Inside it, the agent hires
sub-agents: each is a child grant with smaller budget, narrower scope, dial
no higher than parent's. Ceilings: max 10 live, 2 levels deep.

### What already exists
- PR #30 merged · `src/hostpolicy.js` · 7 tests passing

### Steps to build
1. HOST_TIERS, HOST_DEFAULTS (autonomy: ask, maxSubs: 10, maxDepth: 2)
2. `hostLimits(params)` + `hostName(name)`
3. Ceiling enforcement in issueChildGrant
4. POST /api/hosts, GET /api/hosts/:id
5. `agent-host` template
6. Tests: creation, ceilings, depth, revoke drill

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: `master`

---

## WORKFLOW 7: Repo Broker — credential delegation

### What it is
An agent with no GitHub credential reads a diff or opens a PR through a
scoped, revocable grant. The runtime holds the real credential server-side.

### What already exists
- `docs/specs/repo-broker.md` (spec only)

### Steps to build
1. Provision GitHub App (HARD FLOOR)
2. Store credentials in vault
3. Add repo.* caps + scope.repo attenuation
4. Broker: mint installation token, call GitHub REST API
5. MCP tools: repo_read, repo_diff, repo_pr
6. Routes + tests

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: not yet created

---

## WORKFLOW 8: Two-Sided Market — the composition

### What it is
The biggest point. Agents list capabilities, others discover and invoke,
value flows through escrow, reputation accumulates. Composition of every
previous workflow. Cannot exist until escrow keystone (W4).

### What already exists
- Escrow (W4) · Grants (W1) · Autonomy (W5) · Agent-host (W6) · MeshMarket

### Steps to build
1. List (capability + price)
2. Discover (search)
3. Call (open escrow)
4. Deliver (capture)
5. Rate (reputation)
6. Dispute (refund)
7. MCP tools + tests

### Where it lives
Repo: `RightOnPar-LLC/creator-os-runtime` · Branch: not yet created
---

## ADULT SIDE — Parallel Track (steele-os)

Ring-fenced from mainstream. Does NOT share repos, credentials, or deploys
with RightOnPar-LLC.

### A1: Store Foundation ✅ LIVE
Clip pricing, phantom listing detection, settlement verifier.
Repo: `thesteelezone/steele-os` · Recent: `bdbb920`, `bee18f42`

### A2: ROG Go-Live ✅ LIVE
Daemons, poster relay, watcher, OBS integration.
Repo: `thesteelezone/steele-os` · Recent: `5f83498`, `127691a`

### A3: Show Bridge 🔨 IN PROGRESS
OBS ↔ steele-os show control. Needs: SHOW_BRIDGE_SECRET + SHOW_MOD_TOKEN.

### A4: Flywheel 🔄 ONGOING
Automated tick, shelf clean, settlement. Recent: `fb56875`

---

## BOTTOM INDEX — Step-by-Step Checklist

### Workflow 1: Grant Engine
- [ ] 1.1 Schema · [ ] 1.2 mintRoot · [ ] 1.3 issueChild · [ ] 1.4 verify
- [ ] 1.5 settle · [ ] 1.6 revoke · [ ] 1.7 routes · [ ] 1.8 tests green

### Workflow 2: Guest Welcome
- [ ] 2.1 tier · [ ] 2.2 sybil · [ ] 2.3 pool · [ ] 2.4 MCP gate
- [ ] 2.5 quarantine · [ ] 2.6 route · [ ] 2.7 tests green (107)

### Workflow 3: Reservation Reaper
- [ ] 3.1 releaseExpired · [ ] 3.2 reapExpired · [ ] 3.3 timer
- [ ] 3.4 manual trigger · [ ] 3.5 tests green (69)

### Workflow 4: Escrow Keystone
- [ ] 4.1 escrow.hold cap · [ ] 4.2 scope.escrow · [ ] 4.3 buildEscrow
- [ ] 4.4 openEscrow · [ ] 4.5 read helpers · [ ] 4.6 findEscrowGrant
- [ ] 4.7 captureEscrow · [ ] 4.8 self-settle · [ ] 4.9 receipt:mesh
- [ ] 4.10 routes · [ ] 4.11 webhook path · [ ] 4.12 tests green (196)
- [ ] 4.13 senior-gate 0 findings

### Workflow 5: Autonomy Dial
- [ ] 5.1 levels · [ ] 5.2 decide · [ ] 5.3 ledger cols · [ ] 5.4 approvals
- [ ] 5.5 route · [ ] 5.6 value-action checks · [ ] 5.7 tests green

### Workflow 6: Agent Host
- [ ] 6.1 HOST_TIERS · [ ] 6.2 limits + name · [ ] 6.3 ceilings
- [ ] 6.4 POST /api/hosts · [ ] 6.5 GET tree · [ ] 6.6 template
- [ ] 6.7 tests green

### Workflow 7: Repo Broker
- [ ] 7.1 GitHub App (HARD FLOOR) · [ ] 7.2 vault · [ ] 7.3 repo.* caps
- [ ] 7.4 scope.repo · [ ] 7.5 broker · [ ] 7.6 MCP tools
- [ ] 7.7 routes · [ ] 7.8 tests green

### Workflow 8: Two-Sided Market
- [ ] 8.1 list · [ ] 8.2 discover · [ ] 8.3 call · [ ] 8.4 deliver
- [ ] 8.5 rate · [ ] 8.6 dispute · [ ] 8.7 MCP tools · [ ] 8.8 tests green

### Adult Side (steele-os)
- [x] A1. Store foundation
- [x] A2. ROG go-live
- [ ] A3. Show bridge
- [ ] A4. Flywheel

---

## The dependency chain

```
1. Grant Engine
   ├── 2. Guest Welcome
   ├── 3. Reservation Reaper
   │   └── 4. Escrow Keystone
   │       └── 7. Repo Broker
   ├── 5. Autonomy Dial
   │   └── 6. Agent Host
   │       └── 7. Repo Broker (also needs 4)
   └── 8. Two-Sided Market (needs ALL of 1-7)
```

Every workflow is a grant with a different scope block.
The market is the composition of all of them.
Start at 1. Don't skip.