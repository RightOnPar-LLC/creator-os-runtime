# VM ops jobs (meshtool VM, user meshtool) — DevDesk #164

The meshtool VM watches meshtool-prod from the outside and keeps the backups,
so neither depends on the box being healthy.

- `prod-db-backup.sh`: nightly (cron 10:15 UTC) `pg_dump` of the prod runtime DB
  (`pg-runtime`, db `railway`) over the tailnet into `~/prod-backups/daily`, verified
  (every key table has data), 14 daily + 8 weekly kept. `--drill` (cron Sun 10:45 UTC)
  restores it into a throwaway Postgres 18 and checks counts against live.
- `ops-watch.sh`: every minute. Pages the owner (ntfy) when runtime.meshtool.ai fails 3
  checks in a row or is paused; every 15 min checks box disk/memory/reachability, failed
  deploys, a backup older than 26 h and a failed drill. One alert per problem, then
  "Recovered". Log: `~/prod-backups/ops-watch.log`.
- The ntfy topic lives only in `~/.config/meshtool/ntfy.env` (and as `NTFY_URL` in the
  box's `/opt/runtime/prod.env`); it is never committed.
- Receipts: `~/prod-backups/receipts.jsonl`.
- Restore: `pg_restore -d <db> --no-owner <file>` with Postgres 18.
