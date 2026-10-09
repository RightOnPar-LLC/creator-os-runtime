# creator-os-runtime — rescued from Railway

This service existed ONLY inside Railway. It is a Railway *Function*, so its code
lived in the platform rather than in any repository — which is why it appears in
no clone on any box, and why searching the estate for it found nothing. If billing
had lapsed, the code would have gone with it.

- **Pulled:** 2026-09-20, via the Railway API (`get-function-source-code`)
- **Project:** creator-os-runtime · `5ca34256-0fae-44e4-a27b-f7700b20f7e2`
- **Service:** runtime · `9d9ea993-70bc-4516-916e-507efa2131c8` (+ a separate Postgres service)
- **Runtime:** bun 1.4.0, image `ghcr.io/railwayapp/function-bun:1.4.0`
- **Rescued from deployment:** SUCCESS, 2026-09-19T10:02:09Z, 1 replica, us-west2
- **Live at:** https://runtime-production-9d95.up.railway.app
- **Size:** 95,197 JS string chars (95,246 bytes on disk as UTF-8 — the delta is
  em-dashes, not corruption)

`code` and `deployedCode` were **identical** and nothing was staged, so this file
is exactly what was serving.

## What it is

A control plane, not a toy. From its own `/health`:

```json
{"ok":true,"service":"creator-os-runtime","version":"0.1.1","policy":"p1",
 "db":true,"killSwitch":false,
 "armed":{"admin":true,"vault":true,"anthropic":true,
          "railway":false,"stripe":false,"github":false,"brain":false,
          "mesh":false,"cognitiveBridge":false,"sync":false}}
```

Routes include `/api/admin/{overview,events,grants,ledger,memory,outbox,webhooks,kill,resume,deploys}`,
`/api/tenants`, `/mcp`, `/routes`, `/selftest`, `/docs` and
`/.well-known/creator-os.json`. Most integrations are unarmed.

## Secrets — deliberately not read

7 variables are set on the service. They were **not** retrieved. `list-variables`
returns values in plaintext, and an agent transcript is permanent and backed up —
reading them would have made credential rotation the only remedy. Read them from
the Railway dashboard if they are ever needed.

## Why this file exists

A live control plane with a vault, a kill switch and a ledger, existing in no
repository, is one billing lapse away from being unrecoverable. That is the exact
failure `build-the-deploy-path-first` names: **the repo is the unit of delivery**.

This rescue restores the bytes and their lineage. It does not yet restore the
*path* — there is no deploy script, no guard and no ratchet here. Those are the
next steps if this service is to be kept.

## Second rescue — v0.3.0 (2026-09-25)

Live had moved on to **0.3.0** and git had not followed: `index.ts` here is 0.1.1,
`backup/rog-2026-09-22-master` is 0.1.2. 0.3.0 carries the whole **client connect
surface** — `/oauth/register|authorize|approve|token` and `/.well-known/oauth-*`,
with profiles for `devdesk.meshtool.ai` and `market.meshtool.ai` — which existed
nowhere but Railway. A redeploy from this repo would have deleted it.

- **Pulled:** 2026-09-25 via `get-function-source-code`; `code` == `deployedCode`, nothing staged
- **Deployment:** `39b5f211…` SUCCESS 2026-09-24T23:02:26Z
- **File:** `live/runtime-0.3.0.bundle.js` — 85,214 bytes, sha256 `755882b616b8dcd786dd6c86643bd0a66037575094568f35739849af5ea0be3c`,
  identical to the `source.sha256` the service reports at `/health`
- **What it is:** a Bun **bundle** (minified), not source. Railway stores only what
  was deployed; the readable 0.3.0 source was not found on either box and was most
  likely written in a cloud session. The bundle is what runs, so it is what we keep.

`node live/verify.mjs` compares live `/health` against the newest bundle here:
exit 0 in sync, 1 drift, 2 could not check. Run it before any redeploy.

Still open: `index.ts` is 0.1.1 — do NOT deploy it (it would roll the runtime back
two versions and drop the connect surface). The readable 0.3.0 source is the thing
to recover; until then the bundle is the source of truth.

> Superseded 2026-09-25: the readable source was rebuilt and proven identical to
> this bundle (#3), then split into `src/` (#4). `src/` is now the source of truth.
> `index.ts` is still 0.1.1 and nothing deploys it — still do not.

## 0.3.1 — deployed from the repo (2026-09-25)

0.3.1 (#5, `4a470c6`) is the first version that went from git to Railway rather
than the other way round. Its security fixes: an OAuth refresh can no longer
escalate to operator caps; github webhook dedupe keys on the signed body; `/health`
no longer publishes secret fingerprints; `/status` is cached.

It runs on **two** services in project `creator-os-runtime`, the same bytes on both:

| service | kind | URL | deployment |
|---|---|---|---|
| `runtime-svc` · `06be2b2e…` | Dockerfile (`deploy/Dockerfile`, builds `src/` in the image) | https://runtime.meshtool.ai | `20867a03…` 2026-09-25T10:01Z |
| `runtime` · `9d9ea993…` | Railway Function (the original) | https://runtime-production-9d95.up.railway.app | `4559858e…` 2026-09-25T12:24Z |

- **File:** `live/runtime-0.3.1.bundle.js` — 86,019 bytes, sha256 `04789a9b85432f14647142c7dcd115a75f072670a695312aeccf98b6be7cadfa`.
  It is `npm run build` of `4a470c6`, and both URLs report this hash at `/health`.
- **Why the old Function was patched, not retired:** it still carries live traffic
  (claude.ai connector calls to `/mcp`, the admin console). Retiring it means moving
  those clients to `runtime.meshtool.ai` first; deleting the service is a signed step.
- **How the Function was deployed:** a Function's code is its start command,
  `./run.sh <base64 of the file>`. `railway functions push` refuses anything over
  96kb of base64 (~72KB of code), a CLI-only limit — Railway already held the
  113,629-char 0.3.0 command. So it was set with the same API calls the CLI makes
  (`serviceInstanceUpdate` startCommand, then `serviceInstanceDeployV2`).
- **Rollback:** deploy `live/runtime-0.3.0.bundle.js` the same way.
- **Known gap:** the Function generates its own package.json with `hono: latest`;
  the repo and the Dockerfile service pin 4.13.9. The two can drift on a hono release.

`node live/verify.mjs` checks the Function URL by default; add
`--url https://runtime.meshtool.ai` for the Dockerfile service.

## 0.3.2 — merged, not yet on runtime-svc (2026-09-26)

0.3.2 (#9, master `1cfc5a5`) is the diagnostics gate: `cogExecute` asks **lsp-mcp**
(`RightOnPar-LLC/lsp-mcp`, live at https://lsp-mcp-production.up.railway.app, Railway
service `lsp-mcp` `7dd86e11…` in this project) for diagnostics over a proposal's `files`
before the gatehouse signs, and refuses on any error-severity diagnostic. New caps
`code.write`, `lsp.*`; new route `POST /api/grants/settle`. Full account in `src/README.md`
("0.3.2 — the diagnostics gate") and the three commit messages squashed into #9.

- **Expected artifact:** `npm run build` of `1cfc5a5` → `dist/runtime.js`, 93,765 bytes,
  sha256 `2a305897f65707d3812296a0e9441aba5bacd8b173cd340ef935fd1983adb3b3`. The
  Dockerfile builds the same file inside the image, so `/health` → `source.sha256` must
  report this once deployed. (Not committed under `live/` until it IS live.)
- **Gate:** `npm test` 64/64, `npm run test:dist` 64/64; secret scan clean; senior-gate
  high-risk double loop (first-pass review + independent refute pass, both repos), every
  finding fixed and re-verified.
- **runtime-svc `06be2b2e…` still runs 0.3.1** (`/health` version 0.3.1 at 10:09Z).
  `LSP_MCP_URL=https://lsp-mcp-production.up.railway.app` is already set on it (no
  redeploy triggered). The service has **no git source attached** — nothing deploys on
  push; every prior deploy was pushed by hand. Attaching the repo as the source was
  refused by the agent's permission gate, so the deploy is DW's step:
  Railway → `runtime-svc` → Settings → Source → `RightOnPar-LLC/creator-os-runtime`,
  branch `master` (then it deploys on every push), or `railway up` from this repo.
  After it: `curl -s https://runtime.meshtool.ai/health | jq .version,.source.sha256,.armed.lspMcp`
  → `0.3.2`, the hash above, `true`; then
  `node ../lsp-mcp/test/smoke-live.mjs https://lsp-mcp-production.up.railway.app https://runtime.meshtool.ai RUNTIME_ADMIN_KEY`
  (vault read in-process; creates and suspends one `smoke-lsp-*` tenant).
- **The Function `runtime` `9d9ea993…` stays on 0.3.1.** It still serves claude.ai
  connector `/mcp` traffic; its OAuth profile has neither `cog.execute` nor
  `lsp.diagnose`, so 0.3.2 changes nothing it can reach. Bringing it to 0.3.2 is the same
  API dance as 0.3.1 (startCommand base64 of `dist/runtime.js`, 93,765 bytes is under the
  cap) — do it after runtime-svc is verified, or retire it (signed step).
- **Root grants minted before 0.3.2** do not carry the new caps (caps are snapshotted at
  mint). A tenant that needs `lsp.*` gets them via `POST /api/tenants/:id/root-grant`
  (admin, an ACL change — DW-signed). New tenants get them from the start.

### 0.3.2 — LIVE on runtime-svc (2026-09-26 10:30Z, DW-approved)

DW approved attaching the repo as the service source; `runtime-svc` now builds from
`RightOnPar-LLC/creator-os-runtime` @ `master` on every push (deployment `e83410ea…`,
commit `ecf0789`). `/health` at https://runtime.meshtool.ai reports `0.3.2`, `armed.lspMcp
true`, and `source.sha256 2a305897f65707d3812296a0e9441aba5bacd8b173cd340ef935fd1983adb3b3`
(93,765 bytes) — byte-identical to `npm run build` of the same commit, kept here as
`live/runtime-0.3.2.bundle.js`; `node live/verify.mjs --url https://runtime.meshtool.ai` → 0.

Live end-to-end (`lsp-mcp/test/smoke-live.mjs`, tenant `smoke-lsp-*` created then
suspended): root grant carries `lsp.diagnose`; no grant → 403; grant without the cap → 403;
a TS type error is reported at 0:13; a Rust borrow-checker violation (E0382) is reported via
`cargo check` in ~5 s; hover reuses the session; the 7th call on a 6-call grant → 402;
a revoked grant → 403. ALL GREEN.

Housekeeping found on the way: the vault's `RUNTIME_ADMIN_KEY` did not match production
(nor the Function, nor staging); it was refreshed in-process to the production value. The
vault's `RAILWAY_TOKEN` is not authorized for this project (the Railway CLI login is).

### 0.3.2 — the Function `runtime` too (2026-09-26 22:15Z, DW-approved)

DW asked for the Function to follow. Deployed the same way as 0.3.1: `serviceInstanceUpdate`
startCommand `./run.sh <base64 of live/runtime-0.3.2.bundle.js>` (125,029 chars, over the
CLI's limit, under Railway's), then `serviceInstanceDeployV2` → deployment `9aee7837…`.
`LSP_MCP_URL` was set on the service first (no redeploy) so one deploy carried both.
https://runtime-production-9d95.up.railway.app/health → `0.3.2`, `armed.lspMcp true`,
`source.sha256 2a305897…adb3b3` (93,765 bytes) — the same bytes as `runtime-svc`.
Both services run the same bundle again. Known gap unchanged: the Function generates its
own package.json with `hono: latest`; the repo and the Dockerfile service pin 4.13.9.

### lsp-mcp retry fix — the diagnostics dependency hardened (2026-09-26 22:25Z)

The live smoke that verified the Function surfaced a flake in the gate's dependency, not
in the runtime: rust-analyzer intermittently rejected a `hover` on a reused session with
`ContentModified` (`-32801`), which lsp-mcp turned into a 500. `diagnose` — the tool the
gate actually depends on — was never affected. Fixed in `lsp-mcp` (commit `9058b85`,
deployment `a4e9002b` SUCCESS): `LspClient.requestRetrying` retries the LSP-defined
retryable codes `-32801`/`-32802` with linear backoff (hover/definition/references only;
`diagnose` reads notifications, not a request). lsp-mcp is unversioned and deploys on push
to `main`, so there is no runtime bundle change here — recorded because the gate's
correctness rides on this service. Both runtime services re-smoked ALL GREEN afterward
(runtime.meshtool.ai and the Function), hover-on-hot-session included.

## 0.3.3 — reconcile the label to the code, and put both services on it (2026-09-26)

Three feature PRs shipped under one version string: #9 (the lsp-mcp diagnostics gate),
#19 (the `operator_lsp_caps` toggle), #20 (autonomous deploys, `repo-app`/`builder`
templates, `deploy.worker`+`worker.status` on the OAuth operator/devdesk profiles). Live
had drifted three ways: runtime-svc auto-deployed each merge (last hash `e5f7a0bb`), the
Function was still on the first 0.3.2 bundle (`2a305897`, no #19/#20), and the repo's saved
`live/runtime-0.3.2.bundle.js` matched neither — all three labelled "0.3.2". #19 and #20 also
merged with their characterisation tests not updated, so `master` was red (7 failures).

0.3.3 closes it: the tests were reconciled to the intended behaviour of #19/#20 (new
templates, the operator-lsp-caps routes in the snapshot, `scopes_supported` = the full
operator caps, devdesk/operator profiles carrying `deploy.worker`+`worker.status`) — the
7 failures were stale expectations, and the OAuth 401/400 were cascades from the scope
assertion throwing before `access` was set, not issuance bugs. Suite 64/64 on source and on
the bundle.

- **File:** `live/runtime-0.3.3.bundle.js` — 95,580 bytes, sha256
  `af1a52707e9434755b556e818ebc95048c21fdcc124a6eeaa6beb78bbd2a765e`. `npm run build` of this
  commit; the Dockerfile builds the same bytes in-image (same pinned bun 1.4.2, same flags),
  so runtime-svc's `/health` reports this hash after the merge deploy.
- **runtime-svc** (runtime.meshtool.ai): deploys on push to master — 0.3.3 lands on the merge.
- **Function `runtime`** (runtime-production-9d95): deployed to the SAME bundle via the
  startCommand API so both services finally run identical bytes under an accurate label.
- **Released deliberately** (DW: "yes, #20 is intended, release it"): #20 lets the OAuth
  operator (claude.ai connector) and devdesk profiles deploy workers, and `AUTONOMOUS_DEPLOYS=1`
  skips the first-run dry-run gate (budget/scope/limits still apply). `operator_lsp_caps` stays
  a runtime toggle (on in production as of 2026-09-26).
- **Verify:** `node live/verify.mjs --url https://runtime.meshtool.ai` and
  `--url https://runtime-production-9d95.up.railway.app` both exit 0;
  `lsp-mcp/test/smoke-live.mjs` green against both.

## 0.3.4 — guard the empty creator-worker repo (2026-09-26)

#20 repointed the tip-alert / paywall / clips / dm / relay / builder templates to build
from `RightOnPar-LLC/creator-worker`, but that repo is still empty, so a deploy from any of
them would fail obscurely inside a Railway build. `resolveSource` (src/railway.js) now refuses
a build whose source resolves to the creator-worker repo with `409 creator_worker_repo_unpopulated`
(a clear reason, before any Railway call), unless `CREATOR_WORKER_READY=1`. It fires for both
the dry-run and the confirmed path (resolveSource runs before the dry-run branch), so the COG
refuses at plan/execute time too. `probe` (image) and `repo-app` pointed at another populated
org repo are unaffected. Lift the guard by populating creator-worker and setting
`CREATOR_WORKER_READY=1`.

- **File:** `live/runtime-0.3.4.bundle.js` — 95,845 bytes, sha256
  `560c0099e861f2b927c129e5907901a89b2109d47609beddd9806eab6cc9b4eb`. Suite 65/65 on source
  and dist. Both services shipped to this bundle (runtime-svc on merge, Function via startCommand API).

## Retiring the Function `runtime` (2026-10-09, in progress)

`runtime-svc` (https://runtime.meshtool.ai) is the one canonical runtime. It builds `master`
from `deploy/Dockerfile` once CI passes. The Function `runtime` · `9d9ea993…`
(https://runtime-production-9d95.up.railway.app) was the original hand-pasted service from the
September rescue. It now runs a bundle that has drifted from runtime-svc's, and it still costs money.
Retirement is DW's step, because deleting a service can't be undone.

Read-only check, 2026-10-09, last 7 days: 57 requests to the Function. 21 were `/health`, all 2xx.
17 were `/mcp`, **all 4xx**, which means some client still points at the old URL and is being
refused. It has no custom domain. `mcp-gate`'s `RUNTIME_URL` is confirmed as `https://runtime.meshtool.ai`.

1. ✅ `mcp-gate` `RUNTIME_URL` → runtime.meshtool.ai (DW confirmed).
2. ✅ In-repo defaults (`gate/index.ts`, `live/verify.mjs`) now point at runtime.meshtool.ai,
   so a missing variable can no longer fall back to the Function.
3. ☐ Any claude.ai connector still on `runtime-production-9d95…/mcp` → `https://runtime.meshtool.ai/mcp`.
4. ☐ Confirm `/mcp` traffic to the Function is zero for a day.
5. ☐ DW deletes the service `runtime` `9d9ea993…` in Railway (Settings → Delete).
6. ☐ Mark it retired in `_hq` `registry.json`.
