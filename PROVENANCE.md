# creator-os-runtime — rescued from Railway

This service existed ONLY inside Railway. It is a Railway Function, so its code
lived in the platform rather than in any repository — which is why it appears in
no clone on any box. If billing had lapsed, the code would have gone with it.

- **Pulled:** 2026-09-20 via the Railway API ().
- **Project:** creator-os-runtime 
- **Service:** runtime  (+ a Postgres service)
- **Runtime:** bun 1.4.0, image 
- **Deployment rescued from:** SUCCESS, 2026-09-19T10:02:09Z, 1 replica us-west2
- **Live at:** https://runtime-production-9d95.up.railway.app
- **Bytes:** 95197 —  and  were IDENTICAL and nothing was staged,
  so this is exactly what was serving.

## Secrets

7 variables are set on the service. They were deliberately NOT read: 
returns plaintext, and an agent transcript is permanent — reading them would have
made rotation the only remedy. Read them from the Railway dashboard if needed.

## Why this file exists

A live control plane with a vault, a kill switch and a ledger that exists in no
repository is one billing lapse away from being unrecoverable. See the
build-the-deploy-path-first skill: the repo is the unit of delivery.
