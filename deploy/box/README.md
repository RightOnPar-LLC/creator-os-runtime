# Box deploy (meshtool-prod)

runtime.meshtool.ai runs on meshtool-prod (Vultr), not Railway. This folder is how
new `master` commits get there without anyone building by hand.

- `runtime-deploy.timer` runs `deploy.sh` every 5 minutes.
- `deploy.sh` builds the exact commit with `deploy/Dockerfile`, swaps the
  `own-rails-runtime-prod` container, and waits for `/health` to report `ok`,
  `db:true` and the sha256 of the file it just built. Anything else rolls back to
  the previous container. A commit that failed is not retried until a new one lands.
- Out with the old: after a good deploy only the live image and the one before it stay.
- Receipts: `/opt/runtime/deploy/receipts.jsonl` (and an ntfy push if `NTFY_URL` is set).
- Pause: `touch /opt/runtime/deploy/PAUSED`. Resume: delete it.
- Manual rollback: `docker images own-rails-runtime` shows the previous `<sha>-prod`
  image; stop the container and start that image with the same flags as `start_new`.
- Access: a read-only deploy key (`/root/.ssh/runtime_deploy`) that never leaves the box.
- Setup: `deploy/box/install.sh` as root (prints the public key the first time).
