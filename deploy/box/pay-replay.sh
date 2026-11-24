#!/usr/bin/env bash
# PAY daily replay (DevDesk #202). Run by pay-replay.timer once a day. Safe to run by hand.
# Runs pay-replay.mjs inside the prod runtime container (its env holds the admin key; the key never
# leaves the container), keeps the receipt, and pages the owner only on red or a low buyer balance.
set -uo pipefail
STATE_DIR=/opt/runtime/deploy
RECEIPTS="$STATE_DIR/pay-replay.jsonl"
PROD=own-rails-runtime-prod
SCRIPT="$STATE_DIR/pay-replay.mjs"
NTFY_URL="$(sed -n 's/^NTFY_URL=//p' /opt/runtime/prod.env 2>/dev/null | tail -1)"
push() { [ -n "$NTFY_URL" ] && curl -s -m5 -H "Title: $1" -H "Priority: ${3:-default}" -d "$2" "$NTFY_URL" >/dev/null || true; }

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/pay-replay.lock"; flock -n 9 || exit 0
[ -f "$STATE_DIR/PAY_REPLAY_PAUSED" ] && exit 0   # touch to pause; delete to resume

if ! docker cp "$SCRIPT" "$PROD:/tmp/pay-replay.mjs" >/dev/null 2>&1; then
  printf '{"at":"%s","ok":false,"checks":[{"name":"replay script reached the prod container","pass":false}]}\n' "$(date -u +%FT%TZ)" >> "$RECEIPTS"
  push "PAY replay RED" "Could not start the daily replay inside $PROD. Nothing was bought." high
  exit 1
fi
OUT="$(docker exec "$PROD" bun /tmp/pay-replay.mjs 2>&1 | tail -1)"; RC=${PIPESTATUS[0]}
docker exec "$PROD" rm -f /tmp/pay-replay.mjs >/dev/null 2>&1 || true
echo "$OUT" >> "$RECEIPTS"

if [ "$RC" -ne 0 ]; then
  FAILED="$(echo "$OUT" | grep -o '"name":"[^"]*","pass":false' | sed 's/"name":"\([^"]*\)".*/\1/' | head -3 | paste -sd ';' -)"
  push "PAY replay RED" "The daily MeshMarket rail proof failed: ${FAILED:-see $RECEIPTS}. Receipt is on meshtool-prod in $RECEIPTS." high
  exit 1
fi
LOW="$(echo "$OUT" | grep -o 'buyer balance low: [0-9]* MESH left' | head -1)"
[ -n "$LOW" ] && push "PAY: top up the runtime buyer" "$LOW (MeshMarket account meshtool-runtime). The replay still passed." default
exit 0
