# Escrow keystone — spec against the current grant model

**Status:** design · **Owner:** creator-os-runtime (mainstream lane) · **As of:** 2026-09-27
**Precedes:** two-sided market → reputation+stake → instruments → prediction markets (the Promise Economy order)

## The one-line finding

Two of escrow's three states **already exist and are hardened** in the grant engine. The
only genuinely new mechanism is **capture** — resolving held value to a *different party*
on a verified condition. Escrow = a custodial grant + a resolution condition + a
cross-party credit. Do not build a new value engine; extend the one that runs.

## What the current model already gives us (measured, `src/`)

Usage triple everywhere is `{usd_cents, calls, deploys}`; `remaining = budget − reserved − settled`
(`policy.js` `remainingBudget`).

| Escrow state | Already implemented by | Behaviour |
|---|---|---|
| **HOLD** (commit value neither side can freely take) | `issueChildGrant` (`grants.js`) | Locks parent `FOR UPDATE`, checks `usageWithin(childBudget, remaining(parent))`, `parent.reserved += childBudget`, ledger `reserve`. The payer can no longer spend the held amount. **This is an escrow hold.** |
| **SPEND** (terminal) | `settleGrantUsage` (`grants.js`) | `settled += usage`, ledger `settle`/`self-settle`. Permanent, and **within the grant's own tenant** — it credits no one. |
| **REFUND** (return on failure/timeout) | `releaseExpiredGrant` + `reapExpiredGrants` + `revokeGrantTree` (`grants.js`) | Returns the unspent `budget − settled` to `parent.reserved`, ledger `release`. Idempotent (RETURNING-id flip guard). Deadlock-hardened 2026-09-27 (one txn per grant). **This is refund-on-timeout, already built.** |

**The gap:** grant trees are single-tenant, and `settle` credits nobody — it just marks the
payer's own budget spent. There is no cross-party value movement. That is the whole of what
escrow adds.

**MESH today (runtime):** only an inbound receipt webhook — `POST /webhooks/mesh`,
`MESH_RECEIPT_SECRET` (`config.js`, `http.js`). Balances live in **meshmarket**. So roles are
already assigned: **runtime = grant authority + escrow custodian + condition verifier;
meshmarket = the transferable MESH ledger.**

## The escrow grant (the new object, minimally)

An escrow is a child grant with a neutral custodian holder and a resolution block. Reuse
everything; add one scope block and two terminal statuses.

- `sub = "escrow:<id>"` — a custodian neither payer nor payee can spend.
- `budget` = the committed amount (`usd_cents` carries the MESH-denominated commit; `calls`/`deploys` 0 for pure-value escrow).
- new `scope.escrow`:
  ```json
  {
    "payer_grant": "gr_...",
    "payee_tenant": "t_...",
    "payee_ref": "agent:... | grant:...",
    "denom": "mesh",
    "condition": { "kind": "attestation:self-settle | receipt:mesh", "ref": "..." },
    "deadline": 1790000000,
    "on_success": "capture",
    "on_deadline": "refund"
  }
  ```
- status lifecycle: `active → captured | refunded` (both terminal).
  `refunded` = the existing expiry/revoke release path, unchanged. `captured` = the one new state.

## The three operations

1. **open** = `issueChildGrant` with `sub=escrow:*`, the `scope.escrow` block, `exp = deadline`.
   Reserve fires → the payer's value is held. Reuse; add scope validation. Ledger `escrow-hold`.

   How long it is held (as built, `buildEscrow` in `src/escrow.js`). Every rule is checked before
   a hold opens or an approval is filed for the owner, and again when an approval is run:
   - The payer gives `deadline` (unix seconds) or `ttlSec`. With both, the deadline wins. With
     neither, the hold lasts one hour.
   - `deadline` absent, `null` or the number `0` means "not given". Anything else must be a time
     later than now, or the open is refused: `400 escrow_deadline_invalid`. It is never swapped
     for the default hour.
   - `ttlSec`, when given, must be a number (or a string that reads as one): else `400 ttl_invalid`.
   - A time asked for past the payer key's own end is refused: `409 escrow_deadline_exceeds_payer_key`
     (`detail.payer_exp`). If the payer key's end cannot be read, nothing opens.
   - The default hour is not a promise. It still ends at the payer key's own end or at the tier's
     longest lifetime, whichever comes first. The answer carries the deadline the hold really got.
2. **refund** = revoke, or let it expire. Release returns the held value to the payer. **Reuse
   entirely** — the reaper auto-refunds at the deadline, so refund-on-timeout is free. Ledger `escrow-refund`.
3. **capture** (new) = verify the condition, then in **one transaction**: settle the escrow's
   amount (ledger `escrow-capture`) **and** emit a MESH credit to the payee. Only the runtime,
   holding the escrow, can capture; the *condition* is the authorization, never either party's say-so.

## Condition kinds (start with two)

- `attestation:self-settle` — the payee self-settles against a capability grant issued from the
  escrow (mirrors the lsp-mcp 0.3.2 self-settle route), proving delivery. Fully in-house; build first.
- `receipt:mesh` — a signed MeshMarket delivery receipt lands on the existing `POST /webhooks/mesh`
  naming the escrow id → capture. The oracle is already wired.
- Later: `oracle:*` (prediction markets), multi-sig / arbiter (disputes).

## Cross-party credit — the one real design decision

Grant budgets are per-tenant **capability authority**, not fungible currency; do **not** move
budget between trees. Capture credits the payee in **MESH** — the transferable ledger in
meshmarket — via a `mesh.credit` outbox message **keyed by the escrow id** (idempotent, mirrors
the existing `memory.sync` outbox). The runtime stays the custodian + verifier; meshmarket stays
the balance ledger. Value unit in one place, authority state machine in another — the same
brain/git split principle the estate already runs on.

## Ledger + hard floors

- New ledger kinds, kept distinct so the escrow lifecycle is auditable on its own:
  `escrow-hold` (at open), `escrow-capture` (settle + credit), `escrow-refund` (at release).
- **LAW 10 / hard floors:** a **MESH** capture is closed-loop → **auto**, no floor. A capture
  that would move **real money** (`denom:"usd"`, withdrawable) is **money-out → hard floor**,
  gated behind the legal envelope (the doc's wall). `usd` capture is refused until the legal
  structure for that instrument exists.

## API surface (proposed)

- `POST /api/escrow` (cap `escrow.open`) → open; returns escrow id + custodian receipt.
- `POST /api/escrow/:id/capture` — **condition-driven / runtime-internal**, never a party-callable
  free action; verifies the condition, then captures.
- `POST /api/escrow/:id/refund` — payer, or automatic at deadline via the reaper.
- `GET /api/escrow/:id` — state, condition, deadline, resolution.
- MCP: `escrow_open`, `escrow_status`. Capture is condition-driven — never a raw tool call by a party.

## Negative controls (red-before-green — write and prove red BEFORE any green)

1. **No capture without a valid condition** — capture with a bogus/absent receipt → 4xx, status stays `active`.
2. **Double-capture impossible** — capture twice → second is a no-op/409; payee credited once (mirror the reaper idempotency test).
3. **Capture and refund mutually exclusive** — refund-then-capture and capture-then-refund → the second is refused; value is never both captured and refunded.
4. **Deadline auto-refunds** — open with a past deadline, run the reaper → refunded to payer, no capture (rides the existing multi-level reaper test).
5. **`usd` denom capture is gated** — a `denom:"usd"` capture is refused (money-out floor) until the legal flag is set; a MESH capture proceeds.
6. **Held value is un-spendable while escrowed** — after open, the payer's `remaining` reflects the hold; the payer cannot settle the escrowed amount elsewhere.

Every control is proven to fail with its guard removed, then pass with it — and both git and
cognitive-mcp record the outcome (Law 5).

## Build order (smallest shippable first)

1. Escrow grant shape + `POST /api/escrow` open (reuse `issueChildGrant`) + `GET`. Refund-on-deadline is already live via the reaper.
2. `attestation:self-settle` capture + `mesh.credit` outbox + the 6 negative controls.
3. `receipt:mesh` capture via the existing webhook.
4. Two-sided market (list / price / call / pay) on top — the next keystone.

## Why this is the keystone

A two-sided market cannot exist until value can be held on condition between two parties.
Every instrument in the economic-layer table — invest, options, bonds, insurance, prediction
markets, broker — is this escrow with a different condition and a different resolution split.
Ship this and the rest is composition.
