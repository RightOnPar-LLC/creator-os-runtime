#!/usr/bin/env bash
# Pull an off-box backup of the PROD runtime database (pg-runtime on meshtool-prod).
# Runs on the meshtool VM from cron. DevDesk #164 wave 1.
#   prod-db-backup.sh          nightly dump + verify + retention + receipt
#   prod-db-backup.sh --drill  also restore into a throwaway Postgres and compare counts
set -euo pipefail
DIR="$HOME/prod-backups"; mkdir -p "$DIR/daily" "$DIR/weekly"
RECEIPTS="$DIR/receipts.jsonl"
BOX="root@meshtool-prod"
TABLES="tenants grants memories ledger events tool_receipts"
ts="$(date -u +%Y%m%d-%H%M)"; f="$DIR/daily/runtime-prod-$ts.dump"
receipt() { printf '{"at":"%s","job":"%s","outcome":"%s","file":"%s","note":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" >> "$RECEIPTS"; }
fail() { receipt backup failed "${f##*/}" "$1"; echo "FAIL: $1" >&2; exit 1; }

# 1. counts right before the dump (the drill compares against these)
live="$(timeout 60 tailscale ssh "$BOX" "for t in $TABLES; do printf '%s=%s ' \$t \$(docker exec pg-runtime psql -U postgres -d railway -Atc \"select count(*) from \$t\"); done")" || fail "count query failed"
# 2. dump over the tailnet (custom format, no owner)
timeout 600 tailscale ssh "$BOX" "docker exec pg-runtime pg_dump -U postgres -d railway -Fc --no-owner" > "$f.part" || fail "pg_dump failed"
mv "$f.part" "$f"
size=$(stat -c%s "$f"); [ "$size" -gt 100000 ] || fail "dump too small ($size bytes)"
# 3. verify the archive is readable and has data for every key table
toc="$(docker run --rm -v "$DIR/daily:/d:ro" postgres:18 pg_restore -l "/d/${f##*/}")" || fail "pg_restore -l failed"
for t in $TABLES; do echo "$toc" | grep -q "TABLE DATA public $t " || fail "no data section for $t"; done
sha="$(sha256sum "$f" | cut -c1-16)"
echo "$live" > "$f.counts"
# 4. weekly copy on Sundays (UTC), retention: 14 daily, 8 weekly
[ "$(date -u +%u)" != 7 ] || cp "$f" "$f.counts" "$DIR/weekly/"
ls -1t "$DIR"/daily/*.dump | tail -n +15 | while read -r o; do rm -f "$o" "$o.counts"; done || true
ls -1t "$DIR"/weekly/*.dump 2>/dev/null | tail -n +9 | while read -r o; do rm -f "$o" "$o.counts"; done || true
receipt backup ok "${f##*/}" "bytes=$size sha=$sha $live"
echo "backup ok ${f##*/} $size bytes sha $sha"

# 5. restore drill: does the backup actually come back with the same rows?
if [ "${1:-}" = "--drill" ]; then
  c="drill-$$"; trap 'docker rm -f "$c" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$c" -e POSTGRES_PASSWORD=drill -v "$DIR/daily:/d:ro" postgres:18 >/dev/null
  for _ in $(seq 1 30); do docker exec "$c" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  docker exec "$c" createdb -U postgres railway
  docker exec "$c" pg_restore -U postgres -d railway --no-owner "/d/${f##*/}" 2>/dev/null || true
  got=""; for t in $TABLES; do got+="$t=$(docker exec "$c" psql -U postgres -d railway -Atc "select count(*) from $t") "; done
  # tenants/grants/memories must match exactly; busy log tables may only have grown
  # between the count and the dump, never shrunk.
  bad=""
  for t in $TABLES; do
    l="$(echo "$live" | tr ' ' '\n' | sed -n "s/^$t=//p")"; r="$(echo "$got" | tr ' ' '\n' | sed -n "s/^$t=//p")"
    case "$t" in tenants|grants|memories) [ "$r" = "$l" ] || bad+="$t($l->$r) ";;
      *) [ "${r:-0}" -ge "${l:-0}" ] || bad+="$t($l->$r) ";; esac
  done
  if [ -z "$bad" ]; then receipt drill ok "${f##*/}" "restored: $got (live before dump: $live)"; echo "drill ok: $got"
  else receipt drill failed "${f##*/}" "mismatch: $bad"; echo "DRILL MISMATCH: $bad" >&2; exit 1; fi
fi
