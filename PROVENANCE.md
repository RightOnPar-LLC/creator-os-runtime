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
