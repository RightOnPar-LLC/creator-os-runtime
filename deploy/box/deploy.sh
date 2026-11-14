#!/usr/bin/env bash
# creator-os-runtime: pull-deploy master onto meshtool-prod (DevDesk #163, #164).
# Run by runtime-deploy.timer every 5 minutes. Safe to run by hand.
# New master commit -> build image -> STAGING swap + health -> PROD swap + health.
# Any failed step rolls that container back. Two failed commits in a row pause
# auto-deploy (circuit breaker) and page the owner.
set -euo pipefail

BRANCH="${BRANCH:-master}"
SRC=/opt/runtime/src                      # read-only clone (deploy key)
IMG=own-rails-runtime
STATE_DIR=/opt/runtime/deploy
RECEIPTS="$STATE_DIR/receipts.jsonl"
PAUSE="$STATE_DIR/PAUSED"                 # touch to stop auto-deploys; delete to resume
FAILS="$STATE_DIR/consecutive-failures"
MAX_FAILS=2
export GIT_SSH_COMMAND="ssh -i /root/.ssh/runtime_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"; flock -n 9 || exit 0
log() { echo "$(date -u +%FT%TZ) $*"; }
NTFY_URL="$(sed -n 's/^NTFY_URL=//p' /opt/runtime/prod.env 2>/dev/null | tail -1)"
push() { [ -n "$NTFY_URL" ] && curl -s -m5 -H "Title: $1" -H "Priority: ${3:-default}" -d "$2" "$NTFY_URL" >/dev/null || true; }
receipt() { # outcome sha from to note
  printf '{"at":"%s","outcome":"%s","sha":"%s","from":"%s","to":"%s","note":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" "$5" >> "$RECEIPTS"
}
failed() { # outcome sha from to note
  receipt "$@"; echo "$2" > "$STATE_DIR/last-failed"
  n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAILS"
  if [ "$n" -ge "$MAX_FAILS" ]; then
    touch "$PAUSE"
    push "Runtime auto-deploy PAUSED" "$n failed deploys in a row (last: $2 $1: $5). Prod is still on the last good version. Delete $PAUSE to resume." high
  else
    push "Runtime deploy failed: $1" "$2: $5. Prod is unchanged." high
  fi
  exit 1
}

[ -f "$PAUSE" ] && { log "paused ($PAUSE)"; exit 0; }

git -C "$SRC" fetch -q origin "$BRANCH"
SHA="$(git -C "$SRC" rev-parse "origin/$BRANCH")"; S7="${SHA:0:7}"
PROD=own-rails-runtime-prod; STG=staging-runtime
PTAG="$IMG:$S7-prod"; STAG="$IMG:$S7-staging"
CUR="$(docker inspect -f '{{.Config.Image}}' "$PROD" 2>/dev/null || true)"
[ "$CUR" = "$PTAG" ] && exit 0
[ "$(cat "$STATE_DIR/last-failed" 2>/dev/null)" = "$S7" ] && exit 0
log "deploying $S7 (prod: ${CUR:-none})"

# 1. build the exact commit (no working tree, no local edits); one image, two tags
B="$(mktemp -d)"; trap 'rm -rf "$B"' EXIT
git -C "$SRC" archive "$SHA" | tar -x -C "$B"
docker build -q -f "$B/deploy/Dockerfile" -t "$PTAG" "$B" >/dev/null || failed build_failed "$S7" "$CUR" "$PTAG" "docker build failed"
docker tag "$PTAG" "$STAG"
WANT="$(docker run --rm --entrypoint sha256sum "$PTAG" /app/runtime.js | cut -d' ' -f1)"

# swap NAME TAG HEALTH_URL -- docker-run-args...   (returns 0 when healthy, else rolls back and returns 1)
swap() {
  local name="$1" tag="$2" url="$3"; shift 4
  local cur; cur="$(docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null || true)"
  docker rm -f "$name-prev" >/dev/null 2>&1 || true
  if [ -n "$cur" ]; then docker stop "$name" >/dev/null; docker rename "$name" "$name-prev"; fi
  docker run -d --name "$name" --restart unless-stopped "$@" "$tag" >/dev/null || true
  local h
  for _ in $(seq 1 30); do
    sleep 2; h="$(curl -s -m4 "$url" || true)"
    if echo "$h" | grep -q '"ok":true' && echo "$h" | grep -q '"db":true' \
       && echo "$h" | grep -q "\"sha256\":\"$WANT\""; then
      docker rm "$name-prev" >/dev/null 2>&1 || true; return 0; fi
  done
  docker logs --tail 40 "$name" > "$STATE_DIR/failed-$S7-$name.log" 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ -n "$cur" ]; then docker rename "$name-prev" "$name"; docker start "$name" >/dev/null; fi
  return 1
}

# 2. STAGING first (holds the staging watchdog's lock so it doesn't restart mid-swap)
SCUR="$(docker inspect -f '{{.Config.Image}}' "$STG" 2>/dev/null || true)"
exec 8>/run/staging-rail-watchdog.lock; flock -w 120 8 || true
if ! swap "$STG" "$STAG" "http://127.0.0.1:18080/health" -- \
     --network staging-net -p 127.0.0.1:18080:3000 -p 100.85.34.93:18080:3000 --env-file /opt/staging/runtime.env; then
  flock -u 8
  failed staging_failed "$S7" "$CUR" "$PTAG" "staging health failed; logs failed-$S7-$STG.log"
fi
flock -u 8
receipt staged "$S7" "$SCUR" "$STAG" "staging health ok, sha ${WANT:0:8}"

# 3. PROD
PARGS=(--link pg-runtime:pg -p 100.85.34.93:18081:3000)
for f in /opt/runtime/prod.env /opt/runtime/prod-railway.env /opt/runtime/prod-db.env; do [ -f "$f" ] && PARGS+=(--env-file "$f"); done
swap "$PROD" "$PTAG" "http://100.85.34.93:18081/health" -- "${PARGS[@]}" \
  || failed rolled_back "$S7" "$CUR" "$PTAG" "prod health failed, rolled back; logs failed-$S7-$PROD.log"

# 4. good: reset the breaker, out with the old (keep live + previous image per lane)
rm -f "$STATE_DIR/last-failed"; echo 0 > "$FAILS"
for lane in prod staging; do
  keep_new="$IMG:$S7-$lane"; keep_old="$([ $lane = prod ] && echo "${CUR:-none}" || echo "${SCUR:-none}")"
  docker images "$IMG" --format '{{.Repository}}:{{.Tag}}' | grep -- "-$lane\$" \
    | grep -vxF -e "$keep_new" -e "$keep_old" | xargs -r docker image rm >/dev/null 2>&1 || true
done
log "live $S7"; receipt deployed "$S7" "$CUR" "$PTAG" "staging+prod health ok, sha ${WANT:0:8}"
push "Runtime deployed $S7" "Staging then prod passed health (sha ${WANT:0:8})." low
