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
```

The suite boots the runtime on 127.0.0.1 against a throwaway PGlite database (served
over the Postgres wire protocol by `@electric-sql/pglite-socket`), with every outbound
`fetch` blocked. Pinned tool versions live in `test/package.json`; the root
`package.json` dependencies are unchanged.

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
