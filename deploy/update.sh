#!/bin/bash
# Ship a new backend version on the server. Run as ubuntu after copying the package to /tmp:
#   laptop:  scp -i key.pem D:\assist-backend.tgz ubuntu@3.107.133.23:/tmp/
#   server:  bash ~/assist/backend/deploy/update.sh
# Keeps both private settings files (.env and deploy/.env), rebuilds the backend container,
# refreshes the helpers' code and restarts them if they are installed.
set -euo pipefail

PKG=/tmp/assist-backend.tgz
DIR="$HOME/assist/backend"

[ -f "$PKG" ] || { echo "No $PKG — copy it from the laptop first."; exit 1; }

echo "== unpacking new code (settings files are kept)"
tar -xzf "$PKG" -C "$DIR" --exclude='.env' --exclude='deploy/.env'
rm -f "$PKG"

echo "== rebuilding and restarting the backend"
cd "$DIR/deploy"
sudo docker compose up -d --build
sleep 3
curl -fsS http://127.0.0.1:3100/health && echo

echo "== refreshing the helpers' code"
sudo install -d -o assist -g assist /home/assist/helpers
sudo install -o assist -g assist -m 755 "$DIR/deploy/workers/pool.js" "$DIR/deploy/workers/run.sh" /home/assist/helpers/
if systemctl list-unit-files assist-helpers.service >/dev/null 2>&1 && systemctl is-enabled --quiet assist-helpers 2>/dev/null; then
  sudo systemctl restart assist-helpers
  echo "helpers restarted"
else
  echo "helpers not installed as a service yet (see step 6 instructions)"
fi
echo "== done"
