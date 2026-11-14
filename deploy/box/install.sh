#!/usr/bin/env bash
# One-time setup on meshtool-prod (run as root). Re-run safely after adding the deploy key.
set -euo pipefail
KEY=/root/.ssh/runtime_deploy
REPO=git@github.com:RightOnPar-LLC/creator-os-runtime.git
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /opt/runtime/deploy
install -m 0755 "$HERE/deploy.sh" /opt/runtime/deploy/deploy.sh
install -m 0644 "$HERE/runtime-deploy.service" "$HERE/runtime-deploy.timer" /etc/systemd/system/
if [ ! -f "$KEY" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "meshtool-prod runtime deploy (read-only)" -f "$KEY"
fi
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if ! git ls-remote -q "$REPO" HEAD >/dev/null 2>&1; then
  echo "ADD THIS READ-ONLY DEPLOY KEY to RightOnPar-LLC/creator-os-runtime (Settings > Deploy keys, write access OFF):"
  cat "$KEY.pub"; exit 2
fi
[ -d /opt/runtime/src/.git ] || git clone -q --no-checkout "$REPO" /opt/runtime/src
systemctl daemon-reload
systemctl enable --now runtime-deploy.timer
echo "installed; timer: $(systemctl is-active runtime-deploy.timer)"
