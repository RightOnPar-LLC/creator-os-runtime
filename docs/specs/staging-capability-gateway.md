# Staging capability gateway — phase 1

Extends the existing POST /mcp route, verifyGrant, settleGrantUsage, and tool_receipts.
No replacement gateway, memory store, marketplace, model router, Tower or seat.
Disabled by default. No new Cloudflare infrastructure is needed for this phase.

## Enable only in the existing isolated sandbox

Before rollout, prove its database is separate from production, retain the prior deployment
for rollback, and provision a tenant through the existing Runtime operator flow.
Set these non-secret configuration values on that sandbox service only:

- MCP_GATEWAY_PROFILE=staging-v1
- RUNTIME_ENV=staging
- MCP_STAGING_PROJECT_ID=<sandbox project ID>
- MCP_STAGING_ENVIRONMENT_ID=<sandbox environment ID, not its display name>
- MCP_STAGING_TENANT_ID=<dedicated staging tenant ID>

This checks operator-configured pins; it cannot prove database isolation itself.
A name such as staging does not establish isolation. The current sandbox project's
Railway environment is named production; its ID, not that label, is the scope.

Use the existing tenant/root-grant flow to authorize the sandbox project/environment.
Issue a child through the existing POST /api/grants: ttlSec <= 900, caps a subset
of memory.read and ledger.read, an explicit calls budget, zero deploys and zero dollars.
Do not paste its token into chat or commit it. Tokens remain in managed secret custody.

The root, foreign tenants, extra targets, long-lived grants and write/deploy caps are refused.
Every authenticated MCP method checks this envelope. tools/list filters by the caller's caps.
Allowed tools: runtime_health, grant_verify, tool_receipts, ledger_query, memory_search.
The existing memory-partition boundary still applies. guest_welcome is closed on this profile.
Runtime REST routes keep their existing controls; this profile is not an account-wide firewall.

Each allowed tool attempt consumes one call using the existing transactional ledger BEFORE
execution. Failed attempts can consume a call; no automatic refund or retry. A crash can leave
a charged started receipt: reconcile it rather than inventing success. Cap/tool refusals do
not consume a call. Handshakes/listing/ping are rate-limited but are not billed tool calls.
These are grant call units, not a MESH charge; Market/Tower settlement remains their own rail.

Receipt start commits before execution. Completion is awaited. Storage failure blocks execution
or reports unknown execution after completion failure, preserving existing receipt semantics.
Anonymous invalid credentials use the existing bounded rejection-summary policy.
No raw arguments, credentials or memory content are added to receipts.

## Validation and rollout gate

test/staging-gateway.test.js exercises envelope rejection, filtered tool lists, write refusal,
receipt readback, three concurrent requests against two calls, budget exhaustion and revocation.
test/run.mjs runs it in a separate process for both source and production artifact.

Do not call phase 1 live-proven until the existing sandbox is deployed and a narrow real child
grant has completed the same checks there. Retain commit SHA, source hash, deployment ID,
test logs and receipt IDs. No live token or grant has been issued by this branch.

## Ordered next phases

2. Evidence-first audit agent: first inspect the existing repo/GitHub receipt adapters,
source-overlay hashing and sandbox execution lane. Produce a signed manifest that binds
tenant/job, commit SHA, diff hash, test output, trace and artifact hashes. Fail completion if
anything is missing, stale, tampered or for another tenant/commit. Verify with a separate
trusted key reference; never put signing secrets in a bundle. R2 only if evidence exceeds
existing storage; destroy an untrusted sandbox only after durable bundle acknowledgment.
This is NOT implemented here.

3. Agent + Workflow approval engine: extend existing autonomy/approvals/receipt rails.
Cloudflare Workflows supplies durable pause/resume; an Agent/Durable Object holds live
session state only. Bind the owner's authenticated tap to tenant, plan hash, snapshot SHA,
evidence hash and one-use approval version. Changed content invalidates the tap. Refusal,
expiration, replay, other tenants and unauthenticated callbacks cannot resume. Recheck
grant expiry/revocation and budget on resume; an approval never widens authority.
Use cognitive-mcp as memory of record. This is NOT implemented here.

## Closeout / compounding

Original reusable lesson: pin account/environment/tenant independently of staging names,
reuse the transaction meter and receipt middleware, and test parallel exhaustion.
No new personal skill or marketplace listing: phase 1 is not live-proven, so publishing a
working capability claim would be premature. Preserve this candidate for a verified closeout.
