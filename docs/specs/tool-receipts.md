# Runtime tool receipts — first coverage boundary

Status: **FIRST BOUNDARY READY FOR REVIEW; overall tool routing IN PROGRESS. Not merged or deployed.**

## Agent handoff — start here

Owner: codex:tool-receipts. Branch: feat/runtime-tool-receipts.
Base: origin/master c947999. Follow this branch's files and the pull request;
local checkout details belong in the private shared handoff, not this public repo.

| Work item | State | Evidence / what remains |
|---|---|---|
| Runtime MCP tool receipt boundary | IMPLEMENTED + TESTED LOCALLY | 314 tests pass, including secrets, subtree isolation and storage-failure controls. Not live. |
| Existing authenticated HTTP tool routes + Railway start | IMPLEMENTED + TESTED LOCALLY | Route templates only; authority provenance recorded; existing auth behavior preserved. |
| Receipt lookup (HTTP + MCP) | IMPLEMENTED + TESTED LOCALLY | Existing ledger.read; own subtree; operator-only anonymous summaries. |
| Negative controls | VERIFIED LOCALLY | Removing the boundary, forcing success and leaking siblings each cause assertion failures. |
| Production bundle | VERIFIED LOCALLY | tools/build.mjs succeeds; built artifact suite 314 pass / 0 fail. |
| Independent review | APPROVED FOR THIS SCOPE | Two independent reviewers approved after fixes; author ran source/artifact tests. |
| Commit / pull request / CI | NOT YET FILED | Commit only this change after checks/review; open draft PR and link it here. |
| Merge / production deployment / live receipt | NOT DONE | No production code, schema, credentials or client routing changed. |
| Market/gatehouse correlation | NOT BUILT | Reuse market settlement + existing gatehouse chain; reconcile their identities with runtime grants. |
| Local shell/filesystem/Chrome adapters | NOT BUILT | Need runtime authorization before effects and executor-attested completion; direct calls still bypass runtime. |
| Public HTTP guest/OAuth/webhooks/background coverage | NOT BUILT HERE | Existing records retained; explicit exclusions below. Do not claim universal receipts. |

### Where I left off / next executable step

1. File this tested boundary as a pull request; update its link and CI status.
2. Check the PR checks and comments, resolve concrete findings, then merge/deploy
   under existing authority and verify an actual live grant receipt. Never mark
   the local test receipt as production evidence.
3. Continue market/gatehouse correlation and the missing local adapters above.
   Claim the next unowned step before editing; do not duplicate an active owner.
4. Keep the current state and exact next action here. The shared handoff points
   agents to this record automatically on startup; no request from the user is
   needed to discover it. Do not repoint clients or mint a grant for a green demo.

### Agent response log

Append dated responses here: agent identity, finding or action, status, exact
file/commit/receipt evidence, and next owner/step. Keep old entries; supersede a
claim explicitly. Use IMPLEMENTED, VERIFIED, NOT BUILT, IN PROGRESS or BLOCKED
with a specific reason. Never mark the entire routing project DONE because one
boundary passed. Announce cross-agent changes with the project coordination channel, and update the shared handoff when stopping.

- Initial independent refute: anonymous per-request writes could exhaust storage;
  approved_not_run could be called succeeded; authority provenance ambiguous;
  some entrypoints omitted. Fixed or explicitly excluded as described below.
  Final review approved the scoped boundary after these changes. The second
  independent review found an implicit HEAD bypass, now fixed and regression-tested.
  Both reviewers also approved the final persisted-row-count checks. Reviewers
  inspected source and test assertions; test execution is recorded by the author.


Decision: an execution start must be durable before the handler can act. A
client post-hoc log or a gatehouse-only record cannot prove this for direct
runtime requests, so the boundary belongs beside runtime authentication.
Tripwire: moving either start or completion to a fire-and-forget callback or
queue breaks this guarantee and must fail the negative controls.

## What already exists

- MeshMarket's /mcp routes priced capability calls through its own settlement
  and receipt machinery; it is independent of the existing MCP gatehouse.
- The existing MCP gatehouse mediates selected upstreams, checks identity/tool
  ACLs, and writes a local hash chain. It is not universal tool coverage. Its current
  receipt writer catches storage failures, and it writes after responding.
  Preserve it as existing evidence; do not mistake it for this durability gate.
- Runtime grant validation, the autonomy dial, approvals, scoped ledger, tours,
  and bus outbox already exist. This change reuses their authority decisions;
  it does not mint grants, lift a dial, duplicate settlement, or change caps.

## Covered here

- Runtime POST /mcp tools/call, including public guest_welcome.
- Registered /api/* routes tagged with grant or operator authentication.
- Grant-authenticated GET /auth/railway/start.
- Receipt lookups themselves are excluded from HTTP audit to avoid read noise;
  the MCP tool_receipts lookup is a tool call and is receipted.

Each admitted execution gets a runtime-generated tr_ id and the
X-Runtime-Receipt response header. The start binds verified grant/tenant IDs,
or a closed operator_key/operator_session/public_guest_policy authority kind,
before execution. No arguments, results, cookies, raw targets/queries, or tokens
are stored. Operation names are server tool names or registered route templates.

Unauthenticated rejections aggregate into ONE atomic counter receipt per UTC
minute, across replicas, regardless of supplied IP/name/token. These are clearly
record_kind=rejection_summary, with attempts, and never pretend to be individual
executions. Known authenticated grant denials remain ordinary invocation rows
when their identity has already been verified. The public MCP guest bootstrap
also has a separate global 120/minute admission meter before receipt creation.

A completion is awaited before the response leaves. JSON-RPC errors inside HTTP
200 count as failed/denied. Awaiting approval is pending_approval; an explicit
executed:false or approved_not_run is not_run. succeeded means the handler
completed successfully, not that an external deployment independently passed a
health check. A crash leaves started; that is unresolved execution, never success.

If start storage fails: 503 receipt_unavailable, executed:false, no handler.
If completion storage fails: 503 receipt_completion_unavailable, execution:unknown,
retry_safe:false, and the durable start remains. Never automatically replay a
mutation on this response. No exactly-once side-effect claim is made.

GET /api/tool-receipts and MCP tool_receipts require existing ledger.read and
filter to the verified caller's grant subtree, within its tenant. The operator
can inspect all rows via GET /api/admin/tool-receipts, including anonymous summary
rows. Limits are 200 on HTTP and 1–200 (default 50) on MCP.

## Explicit remaining coverage — do not claim all tools are routed

Direct agent shell/filesystem/browser calls, independently configured remote
MCP connections, and arbitrary third-party MCP tools still bypass this
runtime. Their grants are not interchangeable. Runtime public HTTP /api/guest,
OAuth register/token and Railway callback, webhook/sync handlers, and internal
background work retain their existing records; they are not covered by this new
invocation boundary. The exclusions below delimit this change.

Next: adapt the existing gatehouse as the external MCP boundary, correlate its
execution/receipt id to runtime authority and receipts, then add a local executor
for shell/filesystem/Chrome. Local executors must obtain bounded runtime authority
BEFORE effects and report completion as executor-attested, not runtime-observed.
An adapter that merely posts a retrospective receipt is observation, not enforced
routing. Never repoint all clients until allow/deny, unavailable-runtime, and
lost-completion controls pass; never substitute an admin or fleet credential for
a caller grant. Validate existing credentials before requesting new authority.

## Validation

node test/run.mjs; node tools/build.mjs; node test/run.mjs dist.
node test/tool-receipts-controls.mjs deliberately removes the MCP boundary,
mislabels failures as success, and leaks sibling receipts; each must fail actual
assertions, with the source restored afterward. Tests use a throwaway database;
no live grants or production deployments are used.

## Verification receipt

Source suite: 314 pass, 0 fail. Built artifact suite: 314 pass, 0 fail.
Negative controls: all 3 deliberate breaks were caught by assertions; sources
restored. Two independent reviews approved the scoped change after fixes.
No production migration, deployment, grant issuance or client rerouting occurred.

## Coordination behavior

The owner requires automatic pickup of the latest applicable handoff and active
claims on startup, resume, compaction and before another unit of work. Finish the
current authorized unit before opening another when possible. Every unfinished
item has state, owner, evidence, destination and an exact next step. DONE means
verified at the intended destination; close it out of the active queue and keep
its receipt. Agent responses append dated identity, evidence and next owner/step.
The canonical rule is maintained in the estate handoff contract; local startup
readers and five agent instruction surfaces were configured/checked separately.
Actual delivery by a new session still needs verification; this is not an
unattended worker or an authorization to start unrelated tasks.
