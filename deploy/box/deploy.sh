#!/usr/bin/env bash
# creator-os-runtime: pull-deploy master onto meshtool-prod (DevDesk #163).
# Run by runtime-deploy.timer every 5 minutes. Safe to run by hand.
# One new master commit -> build image -> swap container -> health check
# -> keep it, or roll back to the previous container on any failure.
set -euo pipefail

BRANCH="${BRANCH:-master}"
SRC=/opt/runtime/src                      # read-only clone (deploy key)
NAME=own-rails-runtime-prod
IMG=own-rails-runtime
BIND="100.85.34.93:18081:3000"            # tailnet IP; the Cloudflare tunnel points here
HEALTH="http://100.85.34.93:18081/health"
ENV_FILES=(/opt/runtime/prod.env /opt/runtime/prod-railway.env /opt/runtime/prod-db.env)
STATE_DIR=/opt/runtime/deploy
RECEIPTS="$STATE_DIR/receipts.jsonl"
PAUSE="$STATE_DIR/PAUSED"                 # touch this file to stop auto-deploys
export GIT_SSH_COMMAND="ssh -i /root/.ssh/runtime_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"; flock -n 9 || exit 0
log() { echo "$(date -u +%FT%TZ) $*"; }
receipt() { # outcome sha from to note
  printf '{"at":"%s","outcome":"%s","sha":"%s","from":"%s","to":"%s","note":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" "$5" >> "$RECEIPTS"
  if [ -n "${NTFY_URL:-}" ]; then
    curl -s -m5 -H "Title: runtime deploy $1" -d "$2 $3 -> $4 $5" "$NTFY_URL" >/dev/null || true
  fi
}
NTFY_URL="$(sed -n 's/^NTFY_URL=//p' /opt/runtime/prod.env 2>/dev/null | tail -1)"

[ -f "$PAUSE" ] && { log "paused ($PAUSE)"; exit 0; }

git -C "$SRC" fetch -q origin "$BRANCH"
SHA="$(git -C "$SRC" rev-parse "origin/$BRANCH")"; S7="${SHA:0:7}"
TAG="$IMG:$S7-prod"
CUR="$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)"
[ "$CUR" = "$TAG" ] && exit 0
if [ "$(cat "$STATE_DIR/last-failed" 2>/dev/null)" = "$SHA" ]; then exit 0; fi

log "deploying $S7 (running: ${CUR:-none})"

# 1. build from the exact commit (no working tree, no local edits)
B="$(mktemp -d)"; trap 'rm -rf "$B"' EXIT
git -C "$SRC" archive "$SHA" | tar -x -C "$B"
if ! docker build -q -f "$B/deploy/Dockerfile" -t "$TAG" "$B" >/dev/null; then
  echo "$SHA" > "$STATE_DIR/last-failed"; receipt build_failed "$S7" "$CUR" "$TAG" "docker build failed"; exit 1
fi
WANT="$(docker run --rm --entrypoint sha256sum "$TAG" /app/runtime.js | cut -d' ' -f1)"

# 2. swap: old container is kept stopped as -prev until the new one is healthy
start_new() {
  local args=(-d --name "$NAME" --restart unless-stopped --link pg-runtime:pg -p "$BIND")
  for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && args+=(--env-file "$f"); done
  docker run "${args[@]}" "$1" >/dev/null
}
docker rm -f "$NAME-prev" >/dev/null 2>&1 || true
if [ -n "$CUR" ]; then docker stop "$NAME" >/dev/null; docker rename "$NAME" "$NAME-prev"; fi
start_new "$TAG" || true   # a failed start falls through to the health check and rolls back

# 3. health: ok, db up, not paused, and serving the exact file we built
ok=0
for _ in $(seq 1 30); do
  sleep 2
  h="$(curl -s -m4 "$HEALTH" || true)"
  if echo "$h" | grep -q '"ok":true' && echo "$h" | grep -q '"db":true' \
     && echo "$h" | grep -q "\"sha256\":\"$WANT\""; then ok=1; break; fi
done

if [ "$ok" = 1 ]; then
  docker rm "$NAME-prev" >/dev/null 2>&1 || true
  # out with the old: keep the running image and the one before it (manual rollback)
  KEEP_PREV="${CUR:-none}"
  docker images "$IMG" --format '{{.Repository}}:{{.Tag}}' | grep -- '-prod$' \
    | grep -vxF -e "$TAG" -e "$KEEP_PREV" | xargs -r docker image rm >/dev/null 2>&1 || true
  rm -f "$STATE_DIR/last-failed"
  log "live $S7"; receipt deployed "$S7" "$CUR" "$TAG" "health ok, sha ${WANT:0:8}"
else
  log "health failed for $S7, rolling back to ${CUR:-none}"
  docker logs --tail 40 "$NAME" > "$STATE_DIR/failed-$S7.log" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -n "$CUR" ]; then docker rename "$NAME-prev" "$NAME"; docker start "$NAME" >/dev/null; fi
  echo "$SHA" > "$STATE_DIR/last-failed"
  receipt rolled_back "$S7" "$CUR" "$TAG" "health check failed; logs in failed-$S7.log"
  exit 1
fi
