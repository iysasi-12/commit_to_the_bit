#!/usr/bin/env bash
# Sets up (or updates) Voice Inbox Assistant on a fresh Ubuntu 24.04 Vultr server, behind Caddy
# with automatic HTTPS. Safe to run again: each run pulls the latest main, rebuilds and restarts.
#
#   1. Point the domain's DNS A record (and www) at this server's IP.
#   2. Copy your production env file to the server (never commit it):
#        scp .env.production root@SERVER_IP:/etc/voice-inbox.env
#      It must contain AUTH_URL=https://vocamain.biz and NEXTAUTH_URL=https://vocamain.biz.
#   3. Copy this script up and run it:
#        scp deploy/setup-vultr.sh root@SERVER_IP:/root/
#        ssh root@SERVER_IP "bash /root/setup-vultr.sh"
#   4. Check the live commit matches yours:  curl -s https://vocamain.biz/api/health
set -euo pipefail

DOMAIN="${DOMAIN:-vocamain.biz}"
REPO="${REPO:-git@github.com:iysasi-12/commit_to_the_bit.git}"
BRANCH="${BRANCH:-main}"
APP_USER="voiceinbox"
BASE="/opt/commit_to_the_bit"
APP="$BASE/voice-inbox-assistant"
ENV_FILE="/etc/voice-inbox.env"

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Copy your production env file there first (see the top of this script)."; exit 1; }
grep -q "^AUTH_URL=https://$DOMAIN" "$ENV_FILE" || { echo "$ENV_FILE must set AUTH_URL=https://$DOMAIN"; exit 1; }
chmod 600 "$ENV_FILE"

echo "==> Packages (git, Node.js 24, Caddy, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> App user and code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
HOME_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)"
if [ ! -f "$HOME_DIR/.ssh/id_ed25519" ]; then
  sudo -u "$APP_USER" mkdir -p "$HOME_DIR/.ssh"
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N "" -f "$HOME_DIR/.ssh/id_ed25519" -C "voice-inbox-deploy@$DOMAIN" >/dev/null
fi
sudo -u "$APP_USER" bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"
mkdir -p "$BASE" && chown "$APP_USER:$APP_USER" "$BASE"
if [ ! -d "$BASE/.git" ]; then
  if ! sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO" "$BASE"; then
    echo
    echo "The repository is private. Add this key on GitHub (repo → Settings → Deploy keys → Add, read-only), then run this script again:"
    cat "$HOME_DIR/.ssh/id_ed25519.pub"
    exit 1
  fi
else
  sudo -u "$APP_USER" git -C "$BASE" fetch origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$BASE" reset --hard "origin/$BRANCH"
fi
COMMIT="$(git -C "$BASE" rev-parse HEAD)"

echo "==> Build $COMMIT"
install -o "$APP_USER" -g "$APP_USER" -m 600 "$ENV_FILE" "$APP/.env.local"
sudo -u "$APP_USER" bash -c "cd '$APP' && npm ci && npm test && npm run build"

echo "==> Service"
cat > /etc/systemd/system/voice-inbox.service <<UNIT
[Unit]
Description=Voice Inbox Assistant
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=APP_COMMIT=$COMMIT
ExecStart=/usr/bin/npm start -- -H 127.0.0.1 -p 3000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable voice-inbox >/dev/null
systemctl restart voice-inbox

echo "==> HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}

www.$DOMAIN {
    redir https://$DOMAIN{uri} permanent
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Check"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3000/api/health && echo
echo "Deployed $COMMIT. Now open https://$DOMAIN (Caddy fetches the certificate on the first visit)."
