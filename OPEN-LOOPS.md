

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

## 2026-11-10 Receipt-before-run (DevDesk #112)

- **State:** built and tested (347/0 + negative controls). Opt-in grant constraints `requirePlanReceipt` and `maxLiveActions`.
- **Destination:** runtime.meshtool.ai at 0.3.5. Touches grant rules, so the PR is `needs-human`: DW merges.
- **Round two:** plan receipts for restart/delete, `planHash` in COG proposals, a one-use child grant button in the cockpit.
  Spec: [docs/specs/receipt-before-run.md](docs/specs/receipt-before-run.md).

## 2026-11-10 Plan cheques (DevDesk #113)

- **State:** built and tested (352/0 + negative controls). An "ask" deploy now writes a plan cheque the owner signs from a link.
- **Found and fixed:** the cockpit's approvals list called `GET /api/admin/approvals`, which did not exist (404 live), so pending approvals never showed.
- **Next step (not built):** push `cheque.issued` to DW's phone. Needs a push channel the runtime can reach (no push integration exists in the runtime today).


## 2026-11-11 OIDC issuer for agent seats (DevDesk #128)

- **State:** built and tested (391/0 across the full suite, incl. a dedicated `test/oidc.test.js` that
  signs, cryptographically verifies against the published JWKS, confirms tamper detection, and
  confirms freeze/paperwork gating). New: `GET /.well-known/openid-configuration`, `GET
  /.well-known/jwks.json` (both public, no auth — a relying party fetches these on its own), `POST
  /api/admin/identity/oidc-token` (admin-only; mints an ES256-signed ID token for one seat, refused
  the same way the grant door already refuses an unseated/frozen/quarantined seat — reuses
  `identity.js`'s `paperworkProblem`/freeze checks rather than a second set of rules).
- **Why:** tailwall (the estate's Tailscale tailnet) needs agent seats to join with a short-lived
  verified identity instead of a static auth key. gatehouse was considered and ruled out — it's a
  localhost-only bearer broker by design, not meant to be internet-exposed, and has no asymmetric
  signing. This runtime already signs things (`GRANT_SIGNING_KEY`) and is already public
  (runtime.meshtool.ai), so it's the natural issuer; the new ES256 keypair is separate from
  `GRANT_SIGNING_KEY` (symmetric, internal-only) and from the Ed25519 SSO pass/notice verification
  in `sso.js` (verifies FROM id.meshtool.ai, doesn't sign).
- **Destination:** runtime.meshtool.ai. Touches auth/identity (new token-issuance surface), so the
  PR carries `needs-human` per the estate's auto-merge policy — DW merges.
- **Not built (human action, outside this runtime):** the Tailscale-side half. In Tailscale's admin
  console, Settings → Trust credentials → + Credential → OpenID Connect → Custom issuer, pointed at
  `https://runtime.meshtool.ai`. That step hands back a Client ID and Audience; the Audience is what
  callers pass as `aud` to `POST /api/admin/identity/oidc-token`. Also undecided: whether agent seats
  get tagged `tag:mainstream`/`tag:adult` directly or a new `tag:agent-seat` is added so agent
  identities are distinguishable from device identities in the tailwall ACL (recommended: the new
  tag, scoped narrow on the credential, so a compromised seat token can't self-declare into a lane).

## 2026-11-11 Seat mint: one call makes a whole seat (DevDesk #95)

- **State:** built and tested (396/0 across the full suite; new `test/seats.test.js`, 15 tests). New:
  `POST /api/admin/seats/mint` and `GET /api/admin/seats/mints` (admin-only), table `seat_mints`.
- **What one call does:** claims the payment (one rail + payment ref mints one seat, ever: a retried
  webhook replays), opens a TOUR for the seat (24-hour keys renewed to an end date, budget set once:
  no long-lived key), seats the agent (sponsor/owner/blueprint, via the now-shared `upsertSeat` in
  identity.js), writes SOUL.md / MEMORY.md / MATRIX.md into `agent:<name>:seat` (MATRIX.md is
  generated from the tour's grant, so it cannot drift from the real power), and leaves a receipt
  (`seat_mints` row + `seat.minted` event). A seat never holds more budget than was paid. Any
  failure after the claim undoes the tour, the seat row and the files, and marks the claim `failed`
  so the same payment can be retried. `dryRun` writes nothing.
- **Built on, not beside:** tours.js (time + money), identity.js (seat + freezes), memory.js (files).
  No new grant, key or freeze logic.
- **Destination:** runtime.meshtool.ai. Issues keys, so the PR carries `needs-human` — DW merges.
- **Next steps (not built):** (1) PayRail → mint: a paid self-serve seat arrives as a plan cheque
  the owner signs, which then calls this route (no unattended mint from a webhook). (2) once #89
  (OIDC) merges, the seat's OIDC subject is `<tenant>/agent:<name>`, no extra wiring. (3) the
  Start page "Take a seat" button (DevDesk #120) calls the dry run, then the cheque.
- **Merge note:** #89 also moves the route snapshot to 213 and edits `src/index.js` + `test/run.mjs`;
  whichever lands second rebases (snapshot regenerates with `UPDATE_SNAPSHOT=1 node test/run.mjs`).
