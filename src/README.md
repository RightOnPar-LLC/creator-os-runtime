# src/ — creator-os-runtime 0.3.0, as modules

These files are a **mechanical split** of `tools/rebuild/runtime.js` (the readable
form of the live bundle, proven identical to it). `tools/rebuild/split.mjs` did the
split and proves it: every top-level statement lands in exactly one module with an
identical AST, order is kept inside each module, routes register in their original
order, and nothing reads another module's value before that module has loaded.
`cd tools/rebuild && npm ci && npm run verify` re-checks the whole chain, bundle → readable
file → these modules, byte for byte.

## Modules

| File | Lines | What it does |
|---|---:|---|
| `index.js` | 45 | Entry point. Imports everything, imports the route modules in order, then boots: source hash, schema migration, signing key, kill-switch default, banner. Holds the exports. |
| `config.js` | 57 | Service name/version/policy, `env` (secret values trimmed at load), armed-integration flags, secret fingerprints. |
| `util.js` | 25 | Pure helpers: JSON, time, ids, sha256, HMAC, constant-time compare, HTML escape, `HttpError`. |
| `db.js` | 105 | Postgres via `Bun.SQL`, schema + migration, settings, events, tenant/grant lookups, kill-switch read. |
| `outbox.js` | 72 | Durable outbox to the Brain and the cognitive bridge, retry with backoff. |
| `tokens.js` | 58 | Grant tokens (`cog1.<payload>.<hmac>`) and the AES-256-GCM vault. |
| `policy.js` | 240 | Caps, tiers, usage arithmetic, attenuation rules, the gatehouse, memory-partition boundary check, source-overlay canon + the diagnostics check (0.3.2). |
| `grants.js` | 295 | Mint root, issue child, revoke tree, settle usage, Postgres-backed rate limit, `verifyGrant`. |
| `autonomy.js` | 90 | The autonomy dial: per-grant level (`observe` / `ask` / `act`, default `act`) in `constraints.autonomy`; attenuation refuses a child above its parent; `decide()` gates deploys and escrow opens; `ask` waits for the owner's root grant. |
| `hostpolicy.js` | 70 | Agent-host rules: defaults (dial `ask`, 10 sub-agents, 2 levels, pro+), limits, hire naming `agent:<host>/<role>`, ceiling checks. |
| `bridgewire.js` | 107 | Wire adapter to the cognitive-mcp bridge `/sync` routes: runtime record ↔ bridge `Change` (scope `tenant:mesh:runtime/…`, global `rt:` key). Pull ignores anything outside that prefix. |
| `memory.js` | 110 | Memory write/search/forget, sync records, bridge pull, partition scope check. |
| `railway.js` | 350 | Worker templates; Railway deploy, status, restart, delete (GraphQL). |
| `cog.js` | 355 | COG planner (deterministic, optionally LLM-assisted) and executor; asks lsp-mcp for diagnostics over `proposal.files` before the gatehouse (0.3.2). |
| `webhooks.js` | 177 | Signature checks, idempotency records, Stripe and Railway event handlers. |
| `http.js` | 100 | The Hono `app`, auth middleware (admin / grant / sync token — admin reads only Authorization, never x-grant), route inventory, source-hash state. |
| `mcp.js` | 222 | MCP tool catalogue and JSON-RPC response helper. |
| `oauth.js` | 157 | OAuth client profiles, redirect allow-list, grant issuance for OAuth clients. |
| `cockpit.js` | 212 | Page shell, status report (product probes), docs store, markdown renderer (escapes doc text before the code/bold transforms). |
| `routes/core.js` | 103 | Error handler, 404, `/health`, `/.well-known/creator-os.json`. |
| `routes/admin.js` | 240 | Tenants, kill/resume, policy, breakglass, admin grant ops, read-only admin tables. |
| `routes/grants.js` | 195 | Grant-holder API: grants (incl. self-settle, 0.3.2), cog, deploys, ledger, events, tenant. |
| `routes/memory.js` | 93 | Memory API, `/sync/*`, admin outbox + memory. |
| `routes/railway-auth.js` | 92 | Railway OAuth connect (stores the token in the vault). |
| `routes/webhooks.js` | 198 | `/webhooks/{stripe,railway,github,brain,mesh}` (Railway checks `x-runtime-token`; no `?token=` query fallback). |
| `routes/mcp.js` | 289 | `/mcp` (GET describe, POST JSON-RPC; the per-tool grant check doesn't double-count the rate limit). |
| `routes/oauth.js` | 199 | `/.well-known/oauth-*`, `/oauth/{register,authorize,approve,token}` (refresh-token reuse revokes the grant). |
| `routes/cockpit.js` | 77 | `/`, `/cockpit/:page`, `/status(.json)`, `/docs`, doc upload. |
| `routes/meta.js` | 291 | `/routes` inventory and `/selftest`. |

**Route order matters** (Hono matches in registration order, and `/routes` reports it).
Each `routes/*.js` file is one contiguous run of the original registrations, and
`index.js` imports them in that order. Only `index.js` imports route modules. Add a new
route to the module whose segment it belongs to, or to a new module imported in the
right place. `test/routes.snapshot.json` catches any reordering.

## Production artifact: still one file

Production is a Railway Bun **function**, which runs a single file. `node tools/build.mjs`
bundles `src/index.js` into `dist/runtime.js` with the same shape as the live bundle
(`--target=bun --minify`, `hono` left external for the function image to resolve).
Nothing deploys from this folder or from `dist/` automatically.

### `/health` source hash

`/health` reports `source.sha256` and `source.bytes` of **the file the entry point was
loaded from** (`Bun.file(import.meta.path)` in `index.js`, handed to `recordSource()` in
`http.js`). Bundled, that file is `dist/runtime.js`, the whole runtime, which is exactly
what the live service reports today. Run unbundled (`bun src/index.js`), it hashes
`src/index.js` only, so the number means "which entry file", not "which code". Compare
production hashes against `dist/runtime.js`. This is the only statement the split changed;
`split.mjs` proves nothing else moved. The suite checks the hash against the loaded file for
`src/index.js` and for `dist/runtime.js`.

## Tests

```
cd test && npm ci && cd ..
node test/run.mjs                 # suite against src/index.js
node tools/build.mjs && node test/run.mjs dist   # the same suite against the bundle
node test/run.mjs tools/rebuild/runtime.js       # the same suite against the unsplit original
node test/cancel-controls.mjs     # takes each rule of the cancel (grants.js) out in turn; section 18c must notice
node test/orphans-controls.mjs    # the same for the admin's count of keys left under an ended grant; section 18d must notice
node test/concurrency-real-pg.mjs # NOT in the suite: needs a real, throwaway Postgres in DATABASE_URL (see "Real concurrency")
```

The suite boots the runtime on 127.0.0.1 against a throwaway PGlite database (served
over the Postgres wire protocol by `@electric-sql/pglite-socket`), with every outbound
`fetch` blocked. Pinned tool versions live in `test/package.json`; the root
`package.json` dependencies are unchanged.

Three things the suite depends on that are easy to get wrong:

- **The per-test time limit (30 s) is passed by `run.mjs`.** The pinned bun ignores a
  `timeout` key in `bunfig.toml`; run a test file by hand and you get bun's own 5 s.
- **The rate meters count in fixed wall-clock windows** (a minute; an hour for guest
  mints). A test that fills a meter runs inside `inOneWindow` (`harness.js`), so its
  result counts only if the window did not turn while it ran.
  `node test/window-controls.mjs` breaks each rule on purpose and expects the test
  named for it to go red.
- **"Connection refused" to 127.0.0.1 is the machine, never the runtime**: every
  listener the suite talks to is up for the whole run. The harness asks again and says
  so at the end of the run. A connection the machine *resets* is never asked again (the
  runtime may have acted on it): that run loses one test, with `ECONNRESET`, or with a
  500 from a database connection that was reset (`Connection closed`, or `prepared
  statement ... already exists` on the re-dialed one). Rerun. `node test/loopback-check.mjs`
  says whether a machine is in that state; what was found on one is written at the top
  of that file.

### Real concurrency (`test/concurrency-real-pg.mjs`)

The suite's database is one connection, so in the suite nothing ever waits for a lock: section 18c
stages each "two things at once" case with a trigger. This script is the other half. It imports
`grants.js` and `escrow.js` unchanged, opens the pool exactly as `db.js` does (10 connections,
each its own Postgres backend), and fires the real functions at each other:

0. one fact: two transactions take two rows in opposite order. Postgres ends one after
   `deadlock_timeout`; the script prints what Bun hands back (`grants.js` retries on errno `"40P01"`);
1. keys issued under a grant while it is being cancelled (`issueChildGrant` against `revokeGrantTree`);
2. cancels, sweeps (`reapExpiredGrants`) and captures (`captureEscrow`) over the same payer keys, so
   that real deadlocks happen: the cancel must start again and finish, the sweep must go on to its
   next candidate and must end everything that has run out, an ended capture must leave nothing changed;
3. two or three cancels over grants that overlap;
4. one payment, one credit: a key funded with 100 holds it for a payee, and the hold's own key tries
   to pledge the same 100 again: through the door (refused), and with the second hold already written
   under the first as the old code wrote it, for all of the 100 and for 40 of it. Payees are credited
   100 in all, never 200.

After every round it checks every grant of the round (the seven rules are written out at the top of
the script): what is held on a grant is exactly what the grants under it account for; what it has
settled is what the ledger says; nothing is active under a grant that has ended; every grant let go
exactly once, of exactly what it had not used; a hold was paid out at most once, to the payee it
names. Beside the balances: no cancel may fail on a lost lock wait, no sweep may stop, and nothing
that had run out may still be active after the sweep's passes. It prints rounds, deadlocks (as the
client saw them and as Postgres counted them), retries and violations, and for a broken round who
did what in what order and every row.

```
DATABASE_URL=postgres://... node test/concurrency-real-pg.mjs              # about a minute and a half
DATABASE_URL=postgres://... node test/concurrency-real-pg.mjs --controls   # takes nine rules out in turn; each must go red
```

Exit 0: nothing wrong, and each race was really seen (the list is at the top of the script). 1: a
rule was broken, or something failed that should not. 2: the database or the machine, nothing about
the code. 3: nothing wrong, but a race was never seen, so the run proves less than it should (run it
again, or with more `--rounds`).

**Give it a throwaway database, never a real one.** The sweep ends every grant in the database that
has run out, whoever's it is. The script refuses a Railway host, refuses any host but this machine
without `--remote-ok`, and before it writes anything wants proof the database is its own: it must be
EMPTY (the script then makes the runtime's tables and marks it), or carry the mark of an earlier run.
One run at a time on a database (a second run's sweep would take the first one's grants). Production
is Postgres 18 (Railway's `postgres-ssl:18`). With Docker (line not tried where this was written:
that machine's Docker could not start a container that day; the workflow below does the same thing):

```
docker run -d --rm --name crt-realpg -e POSTGRES_PASSWORD=<pick one> -p 127.0.0.1:54329:5432 postgres:18
DATABASE_URL=postgres://postgres:<the same>@127.0.0.1:54329/postgres node test/concurrency-real-pg.mjs
docker rm -f crt-realpg
```

Without Docker: the PostgreSQL binaries zip, `initdb`, `pg_ctl start` on 127.0.0.1. That is how
it was first run (PostgreSQL 18.4, the Windows build). `.github/workflows/concurrency-real-pg.yml`
runs it, and the controls, on Linux against `postgres:18` for a pull request that touches the files
it is about. That workflow is not the deploy gate (`test.yml` is) and must not be made a required
check: it does not run for other pull requests, and its races are timing.

What a pass does NOT show: timing is random, so a pass is evidence, not proof (the controls say the
checks can go red; the counts say the races were hit). It is one process with one pool, not two
replicas. `lowerGrantAutonomy`, the lazy release in `verifyGrant` and tours are not in it. And the
runtime never lets a held amount go below 0, so where nothing is left held on a grant, taking too
much off it reads as the 0 that is expected anyway: scenario 2 leaves one hold per payer open
through its first check for that reason (a control takes a refund off twice and must be seen), but
a shape this script does not build could still hide one.

## 0.3.2 — the diagnostics gate (lsp-mcp)

No `code.write` or `deploy.worker` grant signs while the source it is about to touch
has an error. A proposal may carry `files: [{path, content}]` (the changed files, as
contents — never paths). `cogExecute` then:

1. canonicalises the overlay (`normalizeOverlay`: no absolute paths, no `..`, sorted,
   size-capped) and hashes it (`overlayHash`, the same form lsp-mcp uses);
2. calls lsp-mcp `diagnose` over it, presenting the **caller's own grant** — lsp-mcp
   introspects that grant back here (`GET /api/grants/verify`) and charges it
   (`POST /api/grants/settle`), so the caller must hold `lsp.diagnose` and budget;
   anything the caller attached as `diagnostics` is discarded;
3. hands the proposal, with the fetched result attached, to `gatehouseEvaluate`, which
   refuses with `diagnostics_missing` / `diagnostics_stale` (hash mismatch) /
   `diagnostic_error:<path>:<line>:<col>:<message>` per error. Warnings pass and are
   recorded as a `cog.diagnostics.warnings` event.

lsp-mcp unreachable, unconfigured (`LSP_MCP_URL`), or refusing → `gatehouse_denied`
with `diagnostics_unavailable:…` / `diagnostics_refused:…`. Never waved through.
A proposal without `files` is the pre-0.3.2 flow, untouched. `code.write` without
`files` is refused (`code_write_requires_files`).

**What is actually bound.** `code.write` is issuable ONLY through `cogExecute`:
`issueChildGrant` requires a runtime-fetched diagnostics attestation for that cap
(`attenuationViolations` → `code_write_requires_diagnostics` on the direct REST and MCP
grant routes), and the issued grant carries `scope.code.filesSha256`, the hash of the
diagnosed overlay. Whatever honours `code.write` must check that the bytes it writes are
that overlay. `cog.executed` events record the same hash. Deploys via the COG with
`files` are gated the same way; deploys of template images without `files` (the direct
`/api/deploys` route) carry no source and are not, which is their pre-0.3.2 behaviour.

Cost: one gated execute spends three rate-limit slots on the caller's grant (the route,
lsp-mcp's verify, lsp-mcp's settle) and one `calls` of budget; grant budgets in the
proposal are clamped to what remains after that charge. The caller's own token is what
lsp-mcp sees (first-party, held in memory, never logged); a least-privilege ephemeral
child grant for that hop is a follow-up.

New caps: `code.write`, `lsp.diagnose`, `lsp.hover`, `lsp.definition`, `lsp.references`.
Caps are snapshotted into a grant row at mint time, so **root grants minted before
0.3.2 do not carry them**; re-mint with the admin route `POST /api/tenants/:id/root-grant`
(an ACL change — DW-signed, never automatic). New tenants get them from the start.

Config: `LSP_MCP_URL` (no secret; lsp-mcp holds none either), `LSP_MCP_TIMEOUT_MS`
(default 120000, max 240000 — a Rust `cargo check` can take a while; the server's
`idleTimeout` is 255 s so the socket outlives the wait).
