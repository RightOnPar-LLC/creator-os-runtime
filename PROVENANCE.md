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
