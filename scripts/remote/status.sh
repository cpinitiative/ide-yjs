#!/usr/bin/env bash
# Read-only health report for the IDE server. Runs on the VM, sent over SSH by
# the "IDE server status" workflow:
#
#   status.sh <app dir> <health host>
#
# It changes nothing on the VM. Its output goes to a public Actions log, so it
# never prints env vars, .env or raw server logs: log lines can name docs, and
# a doc's name is enough to open it in the IDE. Log lines are summarized with
# doc names and long IDs redacted instead.
set -uo pipefail

APP_DIR=$1
HEALTH_HOST=$2
HEALTH_URL=${IDE_HEALTH_URL:-https://$HEALTH_HOST/}

unhealthy=no
section() { printf '\n== %s ==\n' "$1"; }
warn() { printf '::warning::%s\n' "$*"; }

# Load nvm like an interactive shell would, so node and pm2 resolve the same way
if [ -s "${NVM_DIR:=$HOME/.nvm}/nvm.sh" ]; then
  set +u
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  set -u
  HAS_NVM=yes
else
  HAS_NVM=no
fi

# PM2 runs as root (`sudo pm2 ...`), with this user's PATH like the deploy uses
as_root() { sudo -n env "PATH=$PATH" "$@"; }
git_() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }

section "Host"
uptime
uname -sr
# shellcheck source=/dev/null
if [ -r /etc/os-release ]; then (. /etc/os-release && echo "$PRETTY_NAME"); fi
echo "SSH user: $(id -un)"
if sudo -n true 2>/dev/null; then echo "Passwordless sudo: yes"; else warn "Passwordless sudo: no (PM2 runs as root, so deploys need it)"; fi

section "Memory"
free -m

section "Disk"
df -h / "$APP_DIR" 2>/dev/null | awk '!seen[$0]++'

section "Node and PM2"
echo "nvm: $HAS_NVM"
echo "node (this user): $(command -v node || echo missing) $(node -v 2>/dev/null)"
echo "node (sudo, root's PATH): $(sudo -n sh -c 'command -v node; node -v' 2>/dev/null | tr '\n' ' ')"
echo "pm2: $(command -v pm2 || echo 'not on this user'\''s PATH') $(as_root pm2 --version 2>/dev/null | tail -n1)"

section "App checkout ($APP_DIR)"
if [ ! -d "$APP_DIR" ]; then
  warn "$APP_DIR does not exist on the VM. Fix the IDE_APP_DIR variable."
else
  for f in . .git node_modules dist yjs.db logs; do
    if [ -e "$APP_DIR/$f" ]; then
      printf '%-14s owner %-10s %s\n' "$f" "$(stat -c %U "$APP_DIR/$f")" \
        "$( [ -f "$APP_DIR/$f" ] && du -h "$APP_DIR/$f" | cut -f1)"
    else
      printf '%-14s missing\n' "$f"
    fi
  done
  for f in ecosystem.config.js .nvmrc; do
    if [ -f "$APP_DIR/$f" ]; then echo "$f: present"; else echo "$f: absent"; fi
  done
  [ -f "$APP_DIR/.nvmrc" ] && echo ".nvmrc wants Node $(tr -d '[:space:]' <"$APP_DIR/.nvmrc")"
  echo "Branch: $(git_ symbolic-ref --short -q HEAD || echo 'detached HEAD')"
  echo "Commit: $(git_ log -1 --format='%h %s (%cr)' 2>/dev/null)"
  # Drop any credentials from the remote URL before printing it
  echo "Remote: $(git_ remote get-url origin 2>/dev/null | sed -E 's#//[^/@]*@#//#')"
  changed=$(git_ status --porcelain --untracked-files=no 2>/dev/null | wc -l)
  if [ "$changed" -gt 0 ]; then
    warn "$changed tracked file(s) changed by hand on the VM; deploys refuse to run until that's resolved"
  else
    echo "Local changes to tracked files: none"
  fi
fi

section "PM2 apps"
if ! pgrep -f 'PM2 v.*God Daemon' >/dev/null; then
  warn "No PM2 daemon is running"
else
  # Only safe fields: never the env PM2 stores with each app
  as_root pm2 jlist 2>/dev/null | node -e '
    const fs = require("fs");
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const dir = real(process.argv[1]);
    const input = fs.readFileSync(0, "utf8");
    const start = input.search(/^\[/m);
    if (start < 0) { console.log("Could not read pm2 jlist"); process.exit(0); }
    const apps = JSON.parse(input.slice(start).split("\n")[0]);
    if (!apps.length) console.log("No apps");
    for (const a of apps) {
      const e = a.pm2_env || {};
      const up = e.status === "online" && e.pm_uptime
        ? Math.round((Date.now() - e.pm_uptime) / 3600000 * 10) / 10 + "h" : "-";
      console.log([
        "name=" + a.name,
        "status=" + e.status,
        "restarts=" + e.restart_time,
        "uptime=" + up,
        "memory=" + Math.round(((a.monit || {}).memory || 0) / 1048576) + "MB",
        "node=" + (e.node_version || "?"),
        "script=" + (e.pm_exec_path || "?"),
        "args=" + JSON.stringify(e.args || []),
        "max_memory_restart=" + (e.max_memory_restart ? Math.round(e.max_memory_restart / 1048576) + "MB" : "none"),
        "from_app_dir=" + (real(e.pm_cwd || "") === dir ? "yes" : "no (" + e.pm_cwd + ")"),
      ].join("  "));
    }
  ' "$APP_DIR"
fi

section "Health"
if body=$(curl -fsS --max-time 10 --resolve "$HEALTH_HOST:443:127.0.0.1" "$HEALTH_URL" 2>&1) && [ "$body" = "Hello!" ]; then
  echo "Local check of $HEALTH_URL: OK"
else
  printf '::error::Local check of %s failed: %s\n' "$HEALTH_URL" "$body"
  unhealthy=yes
fi
cert=/etc/letsencrypt/live/$HEALTH_HOST/fullchain.pem
echo "TLS certificate $(sudo -n openssl x509 -enddate -noout -in "$cert" 2>/dev/null || echo 'expiry: unreadable')"
if command -v systemctl >/dev/null; then
  echo "Datadog agent: $(systemctl is-active datadog-agent 2>/dev/null)"
fi

section "Server log summary (last 24h, doc names redacted)"
log=$APP_DIR/logs/ideyjs.log
if ! sudo -n test -f "$log"; then
  echo "No log at $log"
else
  echo "Log file size: $(sudo -n du -h "$log" | cut -f1)"
  # shellcheck disable=SC2016 # JS, not shell
  sudo -n tail -n 50000 "$log" | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n");
    const since = Date.now() - 24 * 3600 * 1000;
    const counts = {}, msgs = {};
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j.timestamp || Date.parse(j.timestamp) < since) continue;
      counts[j.level] = (counts[j.level] || 0) + 1;
      if (j.level !== "error" && j.level !== "warn") continue;
      const m = String(j.message || "")
        .replace(/\b(doc|Doc) \S+/g, "$1 <name>")
        .replace(/[A-Za-z0-9_\-]{16,}/g, "<id>")
        .slice(0, 160);
      const key = j.level + ": " + m;
      msgs[key] = (msgs[key] || 0) + 1;
    }
    console.log("Lines by level:", JSON.stringify(counts));
    const top = Object.entries(msgs).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [m, n] of top) console.log(String(n).padStart(6) + "  " + m);
  '
fi

# A red run means the server isn't answering
[ "$unhealthy" = no ]
