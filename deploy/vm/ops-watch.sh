#!/usr/bin/env bash
# Outside-in watch for meshtool-prod, run every minute from the meshtool VM (DevDesk #164 wave 2).
# Pages the owner's phone via ntfy; one alert per problem, plus a "recovered" note.
set -uo pipefail
. "$HOME/.config/meshtool/ntfy.env"
S="$HOME/.local/state/ops-watch"; mkdir -p "$S"
LOG="$HOME/prod-backups/ops-watch.log"
push() { # key prio title msg  (only when the problem is new)
  [ -f "$S/$1.alerted" ] && return 0
  curl -s -m10 -H "Title: $3" -H "Priority: $2" -H "Tags: rotating_light" -d "$4" "$NTFY_URL" >/dev/null && touch "$S/$1.alerted"
  echo "$(date -u +%FT%TZ) ALERT $1 $4" >> "$LOG"
}
clear() { # key msg
  if [ -f "$S/$1.alerted" ]; then
    rm -f "$S/$1.alerted"
    curl -s -m10 -H "Title: Recovered: $1" -H "Tags: white_check_mark" -d "$2" "$NTFY_URL" >/dev/null
    echo "$(date -u +%FT%TZ) OK $1 $2" >> "$LOG"
  fi
}

# 1. public runtime health, through Cloudflare, every minute; page after 3 misses in a row
h="$(curl -s -m10 https://runtime.meshtool.ai/health || true)"
if echo "$h" | grep -q '"ok":true' && echo "$h" | grep -q '"db":true'; then
  echo 0 > "$S/runtime.fails"; clear runtime "runtime.meshtool.ai is healthy again"
  if echo "$h" | grep -q '"killSwitch":true'; then push killswitch high "Runtime is PAUSED" "Kill switch is on at runtime.meshtool.ai: agents get runtime_paused."; else clear killswitch "Kill switch is off"; fi
else
  n=$(( $(cat "$S/runtime.fails" 2>/dev/null || echo 0) + 1 )); echo $n > "$S/runtime.fails"
  [ $n -ge 3 ] && push runtime urgent "runtime.meshtool.ai is DOWN" "Health check failed $n minutes in a row. Last answer: $(echo "${h:-no response}" | head -c 120)"
fi

# 2. every 15 minutes: box disk/memory, deploys, backups
[ $(( 10#$(date -u +%M) % 15 )) -eq 0 ] || exit 0
box="$(timeout 40 tailscale ssh root@meshtool-prod 'df --output=pcent / | tail -1 | tr -dc 0-9; echo " $(free -m | awk "/Mem:/{print \$7}")"; tail -1 /opt/runtime/deploy/receipts.jsonl 2>/dev/null' 2>/dev/null)"
if [ -z "$box" ]; then push boxreach high "Can't reach meshtool-prod" "The VM couldn't SSH to the box over the tailnet."; exit 0; fi
clear boxreach "meshtool-prod reachable again"
read -r disk memavail <<<"$(echo "$box" | head -1)"
[ "${disk:-0}" -ge 85 ] && push disk high "meshtool-prod disk ${disk}%" "Root disk is ${disk}% full." || clear disk "disk ${disk}%"
[ "${memavail:-9999}" -lt 250 ] && push memory default "meshtool-prod memory low" "Only ${memavail} MB available." || clear memory "memory ${memavail} MB available"
last="$(echo "$box" | sed -n 2p)"
if echo "$last" | grep -qE '"outcome":"(rolled_back|build_failed|staging_failed)"'; then
  push "deploy-$(echo "$last" | sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p')" high "Runtime deploy failed" "$(echo "$last" | head -c 200)"
fi
okb="$(grep '"job":"backup","outcome":"ok"' "$HOME/prod-backups/receipts.jsonl" 2>/dev/null | tail -1 | sed -n 's/.*"at":"\([^"]*\)".*/\1/p')"
age=$(( $(date -u +%s) - $(date -u -d "${okb:-1970-01-01}" +%s) ))
[ $age -gt 93600 ] && push backup high "Prod DB backup is stale" "Last good backup: ${okb:-never} (more than 26h ago)." || clear backup "backup fresh ($okb)"
grep -q '"job":"drill","outcome":"failed"' <(tail -1 "$HOME/prod-backups/receipts.jsonl") && push drill high "Restore drill FAILED" "$(tail -1 "$HOME/prod-backups/receipts.jsonl" | head -c 200)" || true
