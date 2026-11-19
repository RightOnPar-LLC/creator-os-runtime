# Runtime permission before Market execution

State: IMPLEMENTED AND VERIFIED ON meshtool-vm with isolated databases. Live deployment and a real paid acceptance call remain pending. Owner: codex-runtime-market-receipts.

The caller sends POST /api/mesh/call with a real Runtime grant carrying mesh.call, an operation request_id, capability, input, max_mesh, and market_key. The grant's scope.mesh contains key_sha256, an explicit capabilities list, and max_mesh_per_call. Descendants inherit these restrictions and cannot widen them. A tenant root can authorize the first binding. Existing grants do not acquire this capability automatically.

Runtime checks grant signature, tenant status, ancestry, expiry, emergency stop, capability, key digest, tool scope and autonomy. It then locks the grant, rechecks authority and consumes one call allowance while inserting a durable mesh_invocations row linked to the existing tool_receipts record, in one transaction. No Market tool POST occurs until that transaction commits. Runtime records a call allowance, not another monetary debit; Market remains the settlement authority.

The operation ID is single-use within the grant. A duplicate returns the existing receipt; changed input with the same ID is refused. Every attempted request consumes its reserved call even if Market is unavailable; this conservative choice prevents refunded failures becoming unlimited retries. Lost responses and completion-storage failures remain unknown. No automatic paid retry exists.

The first adapter accepts primary Market account credentials. Its read-only account check refuses call-only delegates before tool execution, because those credentials cannot read private account receipts. Only the fixed market.meshtool.ai origin is contacted, redirects are refused, deadlines are bounded, and x-max-price carries the authorized ceiling to Market's settlement boundary. The bound key is sent only to Market and is never stored in Runtime rows or links.

A successful result requires a reconciled Market receipt: call ID, capability, currency, amount, caller debit, provider credit plus fee, and ledger_verified. A held payment is pending_settlement, not success. Unconfirmed delivery remains unknown. No output, raw inputs, credentials or account identifiers enter the displayed receipt. Runtime stores a request digest for replay matching, so this is metadata, not a raw-content archive.

## Human flow

The response has links.runtime and links.market. The Runtime link opens the existing Runtime Browser's receipt view; it requires the owner's existing Runtime sign-in. That view shows the authorization/execution record and an Open Market settlement receipt link. Demo Market receipts remain public; ordinary Market receipts require the paying account's Market browser sign-in. No credentials travel in URLs. Agent receipt reads require ledger.read and stay within tenant/grant subtree.

Use tools/call-mesh.mjs on the VM with an already-issued scoped grant and bound Market key in the process environment. It never mints authority or automatically retries. It prints the two receipt links without logging the tool input/output or credentials.

This path covers POST /api/mesh/call only. Existing direct Market clients and the public /call model loop are not automatically rerouted. There is no universal shell/browser adapter or universal enforcement claim.

## Verification on VM

- Full Runtime source suite: 437 passed, 0 failed.
- Built Runtime artifact suite: 437 passed, 0 failed.
- Twelve adapter controls include deny/no-effect, missing capability, wrong key/tool, excessive ceiling, expired/revoked ancestry, observe/ask, zero budget, concurrent last-call race, repeated operation, lost response, held proof, start-storage failure, completion failure and emergency stop.
- Both independent reviews pass after resolving ordinary-account private receipt compatibility and explicit completion-error shape.
- Independent paired test: actual Runtime with PGlite/Postgres protocol to actual Market Worker with real SQLite; normal account completes local scrub, returns usable result, verifies private receipt. Wrong owner/anonymous/delegate denied; replay makes no second tool call.
- Real Chromium on the VM opens the actual Runtime receipt UI and clicks the Market link; 390px has no horizontal overflow and no browser exceptions. This uses synthetic settlement fixtures and is not live payment evidence.

## Release and real proof

1. Publish the paired MeshMarket owner-receipt change before using normal accounts through this adapter. Run its full selftest and unchanged release gates.
2. Install this exact Runtime artifact into meshtool-vm's existing staging Runtime, with rollback retained. The public production Runtime currently runs on meshtool-prod; do not merge master just to publish staging, since master triggers production deployment.
3. With owner approval for the staging restart, test authority and one additional MESH, use only a fresh test tenant/grant. Staging has copied production data: never borrow another tenant's authority or modify their records. Grant: mesh.call + ledger.read, one call, zero dollars/deploys, safety-scrub only, max_mesh_per_call=1, short expiry, exact test account key digest.
4. From the VM, prove refusal before forwarding, run exactly one live scrub, open both real receipts in Chromium, reconcile the single debit, then revoke the test grant/root. Preserve both IDs and the browser recording. Stop on any uncertain response; no automatic retry or budget increase.
5. Only after that proof, consider the separate production Runtime release and public /call grant-onboarding connection. No existing blanket release/reviewer exception is reused.

No paid call, live grant issuance, production mutation or staging restart was performed for the isolated verification above. Python is not a dependency: Runtime, adapter, CLI, Market change and tests use JavaScript/Bun/Node.
