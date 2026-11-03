

## 2026-10-16 — LM Studio runtime connection (Codex)
Configured C:/Users/vipth/.lmstudio/mcp.json with creator-os-runtime -> https://mcp-gate-production.up.railway.app/mcp (no secrets). Runtime /health and gate /health + OAuth discovery verified. Old screenshot URL returns Railway 404. No saved grant found in vault. Destination: authenticated LM Studio tool list; next step: DW approves browser OAuth from LM Studio Program sidebar, then verify runtime_health. Consent instructions: the-foundry/gates/lmstudio-runtime-oauth.md. No grants issued or permissions changed.

# Open work — runtime tool receipts

## BLOCKED (needs DW): gatekeeper-bridge holds RUNTIME_ADMIN_KEY (found 2026-10-21)

Owner: DW to decide, then the next runtime agent. Evidence: `demos/gatekeeper-bridge/FOLDED-FROM.md`
(PR #64). Railway project `gatekeeper-bridge` is live, runs a build older than the homed source
(every GET returns 501), and holds the runtime master admin key as a variable.
An attenuated grant cannot replace it as-is: `/onboard` calls `POST /api/tenants` and
`/api/tenants/:id/root-grant`, which are admin-only, so only `/grant-soul` and `/soul/write`
could move to a grant. Next step, in order:
1. DW: is the character-builder demo still wanted? If not, stop the Railway service and delete its
   `RUNTIME_ADMIN_KEY` variable (irreversible-delete floor).
2. Either way, treat the admin key as at-risk and rotate it in the sweep. First list every holder
   of the current value, because rotating breaks each one.
3. If the demo stays, it needs a scoped way to create tenants rather than the master key. That
   capability does not exist yet (NOT BUILT).

## IN PROGRESS: runtime routing and receipts (codex:receipt-live-verification)

Current checkpoint (2026-10-17): PR52 merged as bf91893; Railway deployment
caaed56c-ca4a-413b-81b3-fcf436ba93f7 SUCCESS. Source and artifact
314/0, three negative controls, two independent reviews and both PR checks passed.
The merged commit's test check passed. Live health200/db healthy. Operator read
and persisted receipt read-back VERIFIED: tr_NDHP8qRAgDvP, authorized/succeeded,
start+finish timestamps; unauthenticated read denied with receipt header.
The owner explicitly approved the one-time in-memory service-key read after an
automatic review rejection; that check is complete, no credentials changed.
Do not reuse that approval for recurring secret retrieval. Next: real agent-grant
proof and the external adapter contract, using verified existing caller authority.
External adapters and combined Desk view are NOT BUILT. See the current checkpoint
and connection contract in the owning status document. Earlier snapshots below
are historical, superseded by this entry; claim 538 is released.

Canonical status, evidence, unfinished items, resume steps and agent responses:
[docs/specs/tool-receipts.md](docs/specs/tool-receipts.md).

Branch feat/runtime-tool-receipts; local checkout details are in the private shared handoff.
First boundary READY FOR REVIEW; source/artifact suites 314/0 and three negative controls verified.
Implemented locally and tested: runtime MCP + authenticated HTTP receipt boundary,
scoped lookup, failure/denial semantics. Not merged, deployed or live-proven.
Still not built: external MCP/gatehouse/runtime correlation and local executor
adapters. Direct tool calls still bypass the runtime. Next: file the reviewed branch, verify CI, then merge/deploy/live proof and missing adapters. No user approval pending for local
implementation/review work. Read the status document before continuing.

Filed: draft PR https://github.com/RightOnPar-LLC/creator-os-runtime/pull/52; implementation 8a95e55. CI pending; no live rollout. Agents: continue in that PR/branch, record evidence in the status document, and claim the next unowned adapter step.

## 2026-10-30 Runtime seat facelift

- **State:** BLOCKED — existing Runtime admin credentials refused; Railway connector exposes variable names only. No credential reset or backend deploy.
- **Owner:** codex@solidity-slop
- **Destination:** https://runtime.meshtool.ai/
- **Prepared:** cockpit.html derives from the exact public production cockpit with the canonical estate-ui palette ef1ab3a1 and static responsive styling. Functional scripts are byte-identical; hashes are in COCKPIT-RELEASE-2026-10-30.json.
- **Evidence:** Chromium desktop1360/phone390: no overflow or JS exceptions. Public health/routes/docs/status checked. Nine dashboard data endpoints correctly return401 while locked. Existing /routes advertises their actual auth. No Pause, Resume, Drain, money or grant action taken.
- **Approval:** DW explicitly approved live facelift including runtime.meshtool.ai in the owning chat on2026-10-30.
- **Next step:** restore existing authorized Runtime admin access through its established secure flow; review/merge this static document, then PUT its exact bytes to /api/admin/docs/_cockpit. Verify root hash and /health source unchanged. Rollback is the prior cockpit document, not a backend redeploy.

## 2026-11-03 — ordered staging rails build (codex, claim 651)

User outcome: reuse Runtime grants/ledger/MESH/receipts, Market, DevDesk, Tower,
cognitive-mcp and model-router. Build gateway, then evidence audit, then tap workflow.

Phase 1 branch: codex/staging-capability-gateway-20261103, based on origin/master
77bd369. Extends /mcp with an opt-in read-only staging envelope and transactional
call charging. No Cloudflare dependencies, new memory or gateway service.
See docs/specs/staging-capability-gateway.md for configuration and ordered acceptance.

Validation: source retry 350 passed/0 failed; bundled artifact 350 passed/0 failed.
First source run and isolated Market retry hit Windows Postgres connection-closed/setup
timeouts; retained local logs test-staging-source.log and test-staging-market-retry.log.
Successful runs: test-staging-source-retry.log and test-staging-dist.log.
No production changes, live rollout, live grant issuance or live proof.

Existing Railway sandbox confirmed: project 9225d746-82e5-4880-85d2-c646cde3e2e3,
environment f4b7d936-5813-4558-bf0a-dbd9bb9997ad (display name production),
runtime-staging service 254e1f91-1aa7-463a-9f95-76445fccaba5.
Last observed deployment c6c67cc4-f010-4c21-902b-3181fc03eecd SUCCESS.
Do not infer DB isolation from these names.

BLOCKER: automatic review rejected bulk Railway variable-value retrieval to compare
DB targets / check staging admin presence: unnecessary access to all secrets.
No credential values were retrieved by that rejected action. Do not repeat or indirectly
bypass it. Name-only OAuth read succeeded. Need a targeted approved isolation check
and existing staging operator authority before provisioning a narrow test grant.
No money/credential rotation, token creation, deploy or ACL change attempted.

Next: inspect PR/CI, resolve the targeted staging check, deploy only isolated staging,
capture live receipt IDs, then phase 2 signed audit bundle, then phase 3 durable tap engine.
Do not build phases 2/3 in parallel or claim any phase live from local test results.
Compounding: reusable lesson retained in spec; no new skill/listing until live proof.
