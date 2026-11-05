# MeshTool platform realignment — planning review

Status: PLANNING REVIEW COMPLETE; implementation not performed. Owner: codex@solidity-slop. Scope: read-only probes, pinned repository inventory and an offline build executed on meshtool VM. No production configuration, permission, grant, client routing or spending changed.

## Correct the source-drift conclusion

The current master491e7c8845bd5be99826279a6c7b56ff0489c006 builds from src/index.js through deploy/Dockerfile. Bun1.4.2 with the Dockerfile's target/minify/external-hono flags produces181657bytes, SHA25635f18ea8d499064db78c66f7c5a6c43960671470440a8d505d079f46b719c269. Fresh public health reads from runtime.meshtool.ai and staging-runtime.meshtool.ai both report that exact version0.3.4/hash/size. See runtime-source-reproduction-2026-11-01.json.

The95845byte live/runtime-0.3.4.bundle.js archive has hash560c0099e861f2b927c129e5907901a89b2109d47609beddd9806eab6cc9b4eb. Its mismatch with production is real, but that archive is not the current build input. It does not establish a current source/production mismatch. No backend redeploy is required to reconcile these bytes. Build equality is equality to the service-reported artifact hash, not proof of every integration or caller permission.

## Confirmed boundaries and gaps

- GitHub Meshtool is an Organization; think-zone is a User namespace. RightOnPar-LLC/creator-os-runtime remains the actual source repository.
- RightOnPar-LLC/mesh-seats contains Rust source; Meshtool/mesh-seats, Meshtool/meshtool-vm and Meshtool/gate each currently contain only README.md. These wrappers do not establish runnable onboarding or execution. Similar names alone do not justify a merge or move.
- The existing runtime receipt boundary is live with prior operator read-back evidence. Its own owning specification still marks a real agent-grant proof, external correlation, local executor adapters and unified Desk coverage unfinished. Reuse that boundary; do not implement it a second time.
- The existing gatehouse fronts selected HQ/memory tools. Its README explicitly says MeshMarket is independent of that gate's ACLs and receipts. Running a browser on a VM and obtaining a Market settlement receipt does not establish Runtime pre-execution authorization or a correlated Runtime invocation receipt.
- Public gate health currently returns nonempty expiring and quietTenants arrays with identity/expiry/activity fields. Only aggregate/type/field evidence was retained, not tenant values. Public health should expose aggregate readiness; details belong behind existing authenticated access. No health code changed in this review.

## Recommended implementation order

1. Minimize public gate health output through the existing service; fix inventory references alongside this work without relocating repositories.
2. Verify existing legitimate caller authority and prove one actual agent-grant call through the already-built Runtime receipt boundary. Operator/fleet/adapter credentials cannot stand in for that grant. No one-time secret-read approval is reusable.
3. Implement one explicitly scoped external adapter path: existing human Desk request → runtime grant validation and durable start → VM executor/adapter → one Market capability call → linked Runtime invocation and existing Market settlement receipt → Desk result with both links. Do not introduce another console, runtime, tenant authority or settlement ledger.
4. Require paired denial controls before client rerouting: missing/expired/wrong-tenant/wrong-tool/over-budget grants, unavailable Runtime, and failed durable-start storage all produce zero tool effects. Lost completion remains unknown and is not automatically retried. Correlation must not duplicate payment.
5. Once that pilot verifies, attach onboarding, seat wrappers and further tools to the same contract. Repository consolidation follows ownership/evidence; it is not a prerequisite for the pilot.

The runtime is the authorization and execution-record authority; a seat is tenant-owned identity and scope; a VM is execution capacity; MeshMarket owns pricing and settlement; the Desk presents linked evidence. HQ remains an independent governance observer. Existing services retain these boundaries.

## Exact next step and limits

Next implementation unit, if requested: verify the existing caller-grant entry path and design the one external adapter against docs/specs/tool-receipts.md, then implement/test only that seam. Live publication, credential/access changes or additional paid tool calls still require their applicable authorization. No implementation is implied by this planning review.

The separate approved Market image test remains queued on meshtool-vm for2026-11-02 00:02UTC / November1 4:02PM Pacific, using only15MESH remaining from the prior25. It tests image delivery/settlement, not this new Runtime authorization contract. This review neither cancels nor duplicates it.
