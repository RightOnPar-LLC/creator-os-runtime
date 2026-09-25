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
| `db.js` | 102 | Postgres via `Bun.SQL`, schema + migration, settings, events, tenant/grant lookups, kill-switch read. |
| `outbox.js` | 72 | Durable outbox to the Brain and the cognitive bridge, retry with backoff. |
| `tokens.js` | 58 | Grant tokens (`cog1.<payload>.<hmac>`) and the AES-256-GCM vault. |
| `policy.js` | 171 | Caps, tiers, usage arithmetic, attenuation rules, the gatehouse. |
| `grants.js` | 297 | Mint root, issue child, revoke tree, settle usage, rate limit, `verifyGrant`. |
| `memory.js` | 110 | Memory write/search/forget, sync records, bridge pull, partition scope check. |
| `railway.js` | 350 | Worker templates; Railway deploy, status, restart, delete (GraphQL). |
| `cog.js` | 275 | COG planner (deterministic, optionally LLM-assisted) and executor. |
| `webhooks.js` | 177 | Signature checks, idempotency records, Stripe and Railway event handlers. |
| `http.js` | 91 | The Hono `app`, auth middleware (admin / grant / sync token), route inventory, source-hash state. |
| `mcp.js` | 222 | MCP tool catalogue and JSON-RPC response helper. |
| `oauth.js` | 157 | OAuth client profiles, redirect allow-list, grant issuance for OAuth clients. |
| `cockpit.js` | 191 | Page shell, status report (product probes), docs store, markdown renderer. |
| `routes/core.js` | 103 | Error handler, 404, `/health`, `/.well-known/creator-os.json`. |
| `routes/admin.js` | 240 | Tenants, kill/resume, policy, breakglass, admin grant ops, read-only admin tables. |
| `routes/grants.js` | 173 | Grant-holder API: grants, cog, deploys, ledger, events, tenant. |
| `routes/memory.js` | 93 | Memory API, `/sync/*`, admin outbox + memory. |
| `routes/railway-auth.js` | 92 | Railway OAuth connect (stores the token in the vault). |
| `routes/webhooks.js` | 177 | `/webhooks/{stripe,railway,github,brain,mesh}`. |
| `routes/mcp.js` | 267 | `/mcp` (GET describe, POST JSON-RPC). |
| `routes/oauth.js` | 168 | `/.well-known/oauth-*`, `/oauth/{register,authorize,approve,token}`. |
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
