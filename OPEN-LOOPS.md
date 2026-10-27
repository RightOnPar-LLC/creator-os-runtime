

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
