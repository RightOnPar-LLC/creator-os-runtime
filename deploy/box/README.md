# Box deploy (meshtool-prod)

runtime.meshtool.ai runs on meshtool-prod (Vultr), not Railway. This folder is how
new `master` commits get there without anyone building by hand.

- `runtime-deploy.timer` runs `deploy.sh` every 5 minutes.
- `deploy.sh` builds the exact commit with `deploy/Dockerfile`, swaps **staging-runtime first**
  (must pass health before prod is touched), then the `own-rails-runtime-prod` container, and waits for `/health` to report `ok`,
  `db:true` and the sha256 of the file it just built. Anything else rolls back to
  the previous container. A commit that failed is not retried until a new one lands.
- Out with the old: after a good deploy only the live image and the one before it stay.
- Receipts: `/opt/runtime/deploy/receipts.jsonl` (and an ntfy push if `NTFY_URL` is set).
- Circuit breaker: 2 failed commits in a row create `PAUSED` and page the owner.
- Pause: `touch /opt/runtime/deploy/PAUSED`. Resume: delete it.
- Manual rollback: `docker images own-rails-runtime` shows the previous `<sha>-prod`
  image; stop the container and start that image with the same flags `deploy.sh` uses for prod.
- Access: a read-only deploy key (`/root/.ssh/runtime_deploy`) that never leaves the box.
- PAY daily replay (DevDesk #202): `pay-replay.timer` runs `pay-replay.sh` once a day (17:23 UTC). It makes one real
  MeshMarket purchase through the rail (Safety Scrub, ceiling 3 MESH, about a cent) from a fresh grant on the
  `pay-proof-rail` tenant and checks the job, the agent budget, the ledger and MeshMarket's balance all agree.
  Green is silent; red pages the owner (ntfy, high); a buyer balance under 30 MESH sends a top-up notice.
  Receipts: `/opt/runtime/deploy/pay-replay.jsonl`. Pause: `touch /opt/runtime/deploy/PAY_REPLAY_PAUSED`.
- MeshMarket money settings (in `/opt/runtime/prod.env`; unset = the default): `MESHMARKET_MESH_PER_USD_CENT`
  (default 1.2, the Starter pack's $5 = 600 MESH; budgets are real cents, MESH is converted at this rate rounded up)
  and `MESHMARKET_DAILY_CAP_MESH` (default 300 MESH a UTC day across the whole runtime). An unreadable value
  stops purchases rather than guessing.
- Setup: `deploy/box/install.sh` as root (prints the public key the first time).
