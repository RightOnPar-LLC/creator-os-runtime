# Folded from

- **Source:** untracked folder `gatekeeper-bridge/` in a stray `work-orders` clone (`~/work-orders` on solidity-slop), last edited 2026-10-04.
- **Also preserved at:** `RightOnPar-LLC/work-orders` branch `backup/z13-2026-10-16/home/uncommitted`, commit `e2d6543` (byte-identical, all 5 files compared).
- **Homed:** 2026-10-21 by claude-code@solidity-slop, on DW's "home them". Routed by hq `idea_route` to creator-os-runtime: this is a demo client of the runtime API, so runtime changes are what break it.
- **Edits on fold:** none. Files are as found.

## Deployed state (measured 2026-10-21)

- Railway project `gatekeeper-bridge` (created 2026-10-04, per the 2026-10-09 infra audit, shared memory #2545).
- `https://gatekeeper-bridge-production.up.railway.app` answers, but it is an **older build than this source**: every GET returns Python's `501 Unsupported method ('GET')`, while this source serves `GET /shop`. Redeploying from here would change live behaviour. Do that on purpose, not as a side effect.
- It holds `RUNTIME_ADMIN_KEY` (runtime admin) as a Railway variable. That is a broad key for a demo. If the demo is retired, remove the service and its variable first.
