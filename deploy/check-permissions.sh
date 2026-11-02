#!/usr/bin/env bash
# Read-only check before moving the IDE server from root to the ideyjs user
# and from certbot to Caddy. It changes nothing: it only lists processes,
# ownership, permissions, Node/PM2 setup, certbot's renewal setup and open
# ports. It prints no secrets (only the names of the keys in .env).
#
#   sudo bash deploy/check-permissions.sh
#
# Override the defaults with APP_DIR=... APP_USER=... if they differ.
set -u
APP_DIR=${APP_DIR:-/home/ideyjs/ide-yjs}
APP_USER=${APP_USER:-ideyjs}
HOME_DIR=$(getent passwd "$APP_USER" | cut -d: -f6)
DOMAIN=yjs.usaco.guide

[ "$(id -u)" = 0 ] || { echo "Run with sudo (it only reads)."; exit 1; }
h() { printf '\n== %s\n' "$*"; }
# Node may come from nvm, which non-interactive shells don't load
NVM='for d in "$HOME/.nvm" /usr/local/nvm; do [ -s "$d/nvm.sh" ] && . "$d/nvm.sh" >/dev/null && break; done; '
as_user() { sudo -u "$APP_USER" -H bash -c "$NVM$*" 2>&1; }
as_root() { HOME=/root bash -c "$NVM$*" 2>&1; }

h "User"
id "$APP_USER"
ls -ld "$HOME_DIR" "$APP_DIR"

h "Who runs the server now"
ps -eo user,pid,etime,rss,comm,args --no-headers | awk '$5 ~ /^(node|PM2|npm)/' | cut -c1-200
as_root 'pm2 ls' || echo "pm2 not found for root"
ls -la /root/.pm2/dump.pm2* 2>/dev/null
systemctl list-unit-files 'pm2*' --no-pager 2>/dev/null

h "Ports 80 / 443 / 1234"
ss -ltnup | grep -E ':(80|443|1234)\b' || echo "nothing listening on 80/443/1234"

h "Node and PM2: root vs $APP_USER"
as_root 'echo "root: node=$(command -v node) $(node -v 2>/dev/null)  pm2=$(command -v pm2)"'
ls -ld /root
as_user 'echo "'"$APP_USER"': node=$(command -v node) $(node -v 2>/dev/null)  pm2=$(command -v pm2)"'
as_user "node -e 'const D=require(\"$APP_DIR/node_modules/better-sqlite3\"); console.log(\"better-sqlite3 works for $APP_USER:\", new D(\":memory:\").prepare(\"select 1 as x\").get().x === 1)'" | tail -1

h "Files the app writes (owner:group mode size modified path)"
for f in "$APP_DIR" "$APP_DIR"/yjs.db "$APP_DIR"/yjs.db-wal "$APP_DIR"/yjs.db-shm \
         "$APP_DIR"/logs "$APP_DIR"/logs/* "$APP_DIR"/dist "$APP_DIR"/dist/.env \
         "$APP_DIR"/.env "$APP_DIR"/.git "$APP_DIR"/node_modules "$APP_DIR"/ypersistence; do
  [ -e "$f" ] && stat -c '%U:%G %a %s %y %n' "$f"
done

h "Can $APP_USER write what it needs? (needs: app dir, yjs.db*, logs, dist)"
for f in "$APP_DIR" "$APP_DIR"/yjs.db "$APP_DIR"/yjs.db-wal "$APP_DIR"/yjs.db-shm \
         "$APP_DIR"/logs "$APP_DIR"/logs/ideyjs.log "$APP_DIR"/dist "$APP_DIR"/dist/.env; do
  [ -e "$f" ] || continue
  if sudo -u "$APP_USER" test -w "$f"; then echo "ok        $f"; else echo "NOT WRITABLE $f"; fi
done

h "Anything under $HOME_DIR not owned by $APP_USER (node_modules counted separately)"
find "$HOME_DIR" -xdev -name node_modules -prune -o \
  \( ! -user "$APP_USER" -o ! -group "$APP_USER" \) -printf '%u:%g %m %p\n' 2>/dev/null | head -100
echo "node_modules entries not owned by $APP_USER: $(find "$APP_DIR/node_modules" ! -user "$APP_USER" 2>/dev/null | wc -l)"

h "Anything $APP_USER can't read in the app dir"
sudo -u "$APP_USER" find "$APP_DIR" ! -readable 2>/dev/null | head -50
echo "(end of list)"

h ".env keys (values hidden) and whether SECURITY_KEY is set"
for f in "$APP_DIR"/.env "$APP_DIR"/dist/.env; do
  [ -f "$f" ] || continue
  echo "$f: $(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$f" | tr '\n' ' ')"
  grep -q '^SECURITY_KEY=.' "$f" && echo "  SECURITY_KEY set" || echo "  SECURITY_KEY not in this file (unless PM2 sets it, /copyFile then accepts any caller)"
done

h "Git checkout"
as_user "git -C '$APP_DIR' log -1 --oneline; git -C '$APP_DIR' status --short | head -20"

h "Database copies and old persistence dirs elsewhere on the disk"
find / -xdev \( -name 'yjs*.db*' -o -name ypersistence \) -not -path '/proc/*' \
  -printf '%u:%g %m %s %TY-%Tm-%Td %p\n' 2>/dev/null | head -50

h "PM2 logs (root's)"
ls -la /root/.pm2/logs 2>/dev/null

h "Datadog agent config that mentions the app"
grep -rl -e ide-yjs -e ideyjs /etc/datadog-agent 2>/dev/null || echo "none found"

h "Certbot: certificate, renewal method and hooks"
openssl x509 -noout -issuer -enddate -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem 2>/dev/null || echo "no cert at /etc/letsencrypt/live/$DOMAIN"
grep -E '^(authenticator|installer|webroot_path|pre_hook|post_hook|deploy_hook|renew_hook)' \
  /etc/letsencrypt/renewal/$DOMAIN.conf 2>/dev/null
ls -la /etc/letsencrypt/renewal-hooks/*/ 2>/dev/null
command -v certbot; snap list certbot 2>/dev/null | tail -n +2
systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'certbot|snap.certbot' || echo "no certbot timer"
cat /etc/cron.d/certbot 2>/dev/null | grep -v '^#'; crontab -l 2>/dev/null | grep -i certbot

h "Caddy / other web servers"
command -v caddy && caddy version
systemctl is-active caddy nginx apache2 2>/dev/null

h "Firewall on the VM (check the Azure NSG allows TCP 80 and 443 separately)"
ufw status verbose 2>/dev/null || echo "ufw not installed"
