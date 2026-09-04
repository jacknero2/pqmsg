#!/usr/bin/env bash
# Bootstraps a fresh Ubuntu/Debian VPS to run pqmsg behind Caddy (TLS) as a
# systemd service. Idempotent — safe to re-run (e.g. after `git pull`).
#
# Usage (as root, on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/jacknero2/pqmsg/main/deploy/setup.sh | bash
# or, from a local clone:
#   sudo bash deploy/setup.sh
set -euo pipefail

REPO_URL="https://github.com/jacknero2/pqmsg.git"
APP_DIR="/opt/pqmsg"
SERVICE_USER="pqmsg"

if [[ $EUID -ne 0 ]]; then
  echo "run as root (sudo bash deploy/setup.sh)" >&2
  exit 1
fi

echo "==> apt packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> creating service user $SERVICE_USER"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

if [[ -d "$APP_DIR/.git" ]]; then
  echo "==> updating existing checkout"
  git -C "$APP_DIR" pull --ff-only
else
  echo "==> cloning $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

echo "==> npm ci (production deps only — skips electron/electron-builder)"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)

mkdir -p "$APP_DIR/server-data"

if [[ ! -f "$APP_DIR/deploy/pqmsg.env" ]]; then
  echo "==> first run: writing deploy/pqmsg.env with a fresh admin token"
  cp "$APP_DIR/deploy/pqmsg.env.example" "$APP_DIR/deploy/pqmsg.env"
  TOKEN="$(openssl rand -hex 16)"
  sed -i "s|^PQMSG_ADMIN_TOKEN=.*|PQMSG_ADMIN_TOKEN=$TOKEN|" "$APP_DIR/deploy/pqmsg.env"
  echo "    admin token: $TOKEN  (also saved in $APP_DIR/deploy/pqmsg.env)"
  echo "    edit that file now if you want SMTP / a different hostname, then re-run this script."
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 600 "$APP_DIR/deploy/pqmsg.env"

echo "==> installing systemd unit + Caddy site"
cp "$APP_DIR/deploy/pqmsg.service" /etc/systemd/system/pqmsg.service
cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now pqmsg
systemctl enable --now caddy
systemctl reload caddy

PUBLIC_URL="$(grep -m1 '^PQMSG_PUBLIC_URL=' "$APP_DIR/deploy/pqmsg.env" | cut -d= -f2-)"
ADMIN_TOKEN="$(grep -m1 '^PQMSG_ADMIN_TOKEN=' "$APP_DIR/deploy/pqmsg.env" | cut -d= -f2-)"
echo
echo "==> done"
echo "    server:    systemctl status pqmsg"
echo "    caddy:     systemctl status caddy"
echo "    logs:      journalctl -u pqmsg -f"
echo "    dashboard: ${PUBLIC_URL}/?admin=${ADMIN_TOKEN}"
echo "    make sure the DNS A/AAAA record for the host in PQMSG_PUBLIC_URL points at this machine's IP."
