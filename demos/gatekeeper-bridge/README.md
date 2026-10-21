# Gatekeeper Bridge

Small Python service that wires the character-builder demo's ceremonies to the
**real** Meshtool runtime (`https://runtime.meshtool.ai`). The demo page calls
this bridge; the bridge talks to the runtime with real tenants, grants, and
memories.

## What it does

| Demo ceremony | Bridge endpoint | Runtime calls |
|---|---|---|
| Mint soulmate (signup) | `POST /onboard` | `POST /api/tenants` + `POST /api/tenants/:id/root-grant` |
| Soulmate grants an app its soul | `POST /grant-soul` | `POST /api/grants` (parent = soulmate grant) |
| Persist SOUL.md / MEMORY.md | `POST /soul/write` | `POST /api/memory` x2 (kinds `soul`, `memory`) |
| Demo over | `POST /session/end` | none — wipes server-side tokens |

Raw grant tokens **never leave this server**. They are stored in-memory per
session (`secrets.token_urlsafe(32)` ids); the client only ever sees session,
tenant, grant, and memory IDs.

## Deploy (Railway)

1. Push this folder to a repo (or deploy the folder directly).
2. Set the env var `RUNTIME_ADMIN_KEY` to the runtime admin key.
   Railway reads `railway.json` — start command is `python bridge.py`,
   port comes from `$PORT`.
3. Deploy. Note the public URL, e.g.
   `https://gatekeeper-bridge-production.up.railway.app`.
4. Point the demo page at that URL for its ceremony calls.

## Local run

```bash
export RUNTIME_ADMIN_KEY='<admin key>'   # never commit this
export PORT=8789                         # optional
pip install -r requirements.txt
python bridge.py
```

Quick check (fails loud without the key):

```bash
curl -s -X POST localhost:8789/onboard \
  -H 'Content-Type: application/json' \
  -d '{"handle":"demo-user","soulmate_name":"Nova"}'
```

## Verified quirks (runtime API, tested 2026-10-04)

- **Caps/budget override:** `POST /api/tenants/:id/root-grant` ignores the
  requested `caps`/`budget` and mints with generous defaults. The bridge
  still sends tight values (`grant.issue`, `memory.read`, `memory.write`,
  50 calls) so the intent is on record; expect the minted grant to be wider.
- **Sub-grant issuing works:** `POST /api/grants` with the parent grant as
  bearer returns a child grant with `parent`/`depth` set — this is the
  soulmate granting ceremony, verified end to end.
- **Memory kinds:** `kind: "soul"` and `kind: "memory"` both accepted on
  `POST /api/memory` with a `memory.write`-capable grant.
- **Cleanup:** `POST /api/tenants/:id/suspend {}` works with the admin key
  if you need to tear down demo tenants.

## Security notes

- `RUNTIME_ADMIN_KEY` is read once at startup; the process exits(2) if unset.
- Tokens are in-memory only — a restart wipes all sessions (demo tenants
  remain on the runtime; suspend them via the API if needed).
- Logs carry method + path + status only. Request/response bodies and tokens
  are never logged, printed, or returned.
- CORS is `*` — this is a public demo page by design. Do not reuse this
  service for anything that needs origin restriction without changing it.
- Python 3.9+ (no 3.10+ syntax).
