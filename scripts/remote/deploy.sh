#!/usr/bin/env bash
# Deploys a commit to the IDE VM, health-checks it, and rolls back to the
# commit that was running before if anything fails. Runs on the VM, sent over
# SSH by the "Deploy IDE server" workflow:
#
#   deploy.sh <app dir> <commit sha> <health host>
#
# Every check that can fail without touching anything runs first. The output
# goes to a public Actions log, so this never prints env vars, .env or server
# logs.
set -euo pipefail

APP_DIR=$1
TARGET=$2
HEALTH_HOST=$3
HEALTH_URL=${IDE_HEALTH_URL:-https://$HEALTH_HOST/}
BACKUP_DIR=${IDE_BACKUP_DIR:-$HOME/ide-yjs-backups}
KEEP_BACKUPS=5
ECOSYSTEM_APP=ide-yjs # the app name in ecosystem.config.js

log() { printf '[deploy] %s\n' "$*"; }
error() { printf '::error::%s\n' "$*"; }
fail() {
  error "$*"
  exit 1
}

# Load nvm like an interactive shell would, so node and pm2 resolve the same
# way as when the app was started by hand. nvm doesn't work under set -eu.
HAS_NVM=no
if [ -s "${NVM_DIR:=$HOME/.nvm}/nvm.sh" ]; then
  set +eu
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  set -eu
  HAS_NVM=yes
fi
nvm_() {
  local rc=0
  set +eu
  nvm "$@" || rc=$?
  set -eu
  return "$rc"
}

# PM2 runs as root (the README starts it with `sudo pm2`). Pass this user's
# PATH so root uses the same node and pm2.
pm2_() { sudo -n env "PATH=$PATH" pm2 "$@"; }
as_root() { sudo -n env "PATH=$PATH" "$@"; }

# git, npm ci and the build run as whoever owns the checkout
OWNER=$(stat -c %U "$APP_DIR")
as_owner() {
  if [ "$OWNER" = "$(id -un)" ]; then
    "$@"
  else
    sudo -n -u "$OWNER" env "PATH=$PATH" "HOME=$(getent passwd "$OWNER" | cut -d: -f6)" "$@"
  fi
}
git_() { as_owner git -C "$APP_DIR" "$@"; }

# PM2 apps started from APP_DIR, one per line:
# name, status, restarts, node major, script, args (space separated)
pm2_apps() {
  pm2_ jlist 2>/dev/null | node -e '
    const fs = require("fs");
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const dir = real(process.argv[1]);
    const input = fs.readFileSync(0, "utf8");
    const start = input.search(/^\[/m);
    if (start < 0) { console.error("Could not read pm2 jlist"); process.exit(1); }
    for (const a of JSON.parse(input.slice(start).split("\n")[0])) {
      const e = a.pm2_env || {};
      if (real(e.pm_cwd || "") !== dir) continue;
      console.log([a.name, e.status, e.restart_time,
        String(e.node_version || "").split(".")[0],
        e.pm_exec_path, (e.args || []).join(" ")].join("\t"));
    }
  ' "$APP_DIR"
}

node_major() { node -p 'process.versions.node.split(".")[0]'; }

health_check() {
  local i body before after
  for i in $(seq 1 30); do
    if body=$(curl -fsS --max-time 5 --resolve "$HEALTH_HOST:443:127.0.0.1" "$HEALTH_URL" 2>&1) &&
      [ "$body" = "Hello!" ]; then
      break
    fi
    if [ "$i" = 30 ]; then
      error "$HEALTH_URL didn't answer Hello! within a minute (last: $body)"
      return 1
    fi
    sleep 2
  done
  log "Server answers. Watching it for 20s to make sure it stays up."
  before=$(pm2_apps | cut -f1-3) || return 1
  if [ -z "$before" ]; then
    error "No PM2 app is running from $APP_DIR"
    return 1
  fi
  sleep 20
  after=$(pm2_apps | cut -f1-3) || return 1
  printf '%s\n' "$after"
  if [ "$before" != "$after" ] || printf '%s\n' "$after" | cut -f2 | grep -qv '^online$'; then
    error "The app restarted or stopped within 20s of starting"
    return 1
  fi
  if ! body=$(curl -fsS --max-time 5 --resolve "$HEALTH_HOST:443:127.0.0.1" "$HEALTH_URL" 2>&1) ||
    [ "$body" != "Hello!" ]; then
    error "$HEALTH_URL stopped answering: $body"
    return 1
  fi
  log "Healthy"
}

# Starts or restarts the app for whatever commit is checked out now
restart_app() {
  local apps name script args
  apps=$(pm2_apps)
  if [ -f "$APP_DIR/ecosystem.config.js" ]; then
    # Remove any other app running from this dir (like the old
    # `pm2 start npm -- start` one), since it would hold port 443
    while IFS=$'\t' read -r name _; do
      [ -n "$name" ] && [ "$name" != "$ECOSYSTEM_APP" ] || continue
      log "Removing PM2 app '$name' (replaced by ecosystem.config.js)"
      pm2_ delete "$name"
    done <<<"$apps"
    log "Starting with ecosystem.config.js"
    (cd "$APP_DIR" && pm2_ startOrRestart ecosystem.config.js)
  else
    # No ecosystem.config.js: run the apps exactly as before this deploy
    if printf '%s\n' "$apps" | cut -f1 | grep -qx "$ECOSYSTEM_APP" &&
      ! printf '%s\n' "$ORIG_APPS" | cut -f1 | grep -qx "$ECOSYSTEM_APP"; then
      pm2_ delete "$ECOSYSTEM_APP"
    fi
    while IFS=$'\t' read -r name _ _ _ script args; do
      [ -n "$name" ] || continue
      if pm2_apps | cut -f1 | grep -qx "$name"; then
        log "Restarting PM2 app '$name'"
        pm2_ restart "$name"
      else
        log "Starting PM2 app '$name' as before: $script $args"
        # shellcheck disable=SC2086 # args were space separated, like `start`
        (cd "$APP_DIR" && pm2_ start "$script" --name "$name" -- $args)
      fi
    done <<<"$ORIG_APPS"
  fi
  pm2_ save
}

install_and_build() {
  log "Installing dependencies"
  (cd "$APP_DIR" && as_owner npm ci --no-audit --no-fund)
  log "Building"
  (cd "$APP_DIR" && as_owner npm run build)
}

#
# Preflight: nothing below changes anything until "Point of no return"
#

[ -d "$APP_DIR/.git" ] || fail "$APP_DIR isn't a git checkout. Check the IDE_APP_DIR variable."
[[ $TARGET =~ ^[0-9a-f]{40}$ ]] || fail "Expected a full commit SHA, got '$TARGET'"
sudo -n true 2>/dev/null || fail "$(id -un) needs passwordless sudo to manage PM2 (it runs as root)"
command -v node >/dev/null || fail "node isn't on $(id -un)'s PATH"

exec 9>"/tmp/ide-yjs-deploy.lock"
flock -n 9 || fail "Another deploy is already running on the VM"

for f in node_modules dist; do
  if [ -e "$APP_DIR/$f" ] && [ "$(stat -c %U "$APP_DIR/$f")" != "$OWNER" ]; then
    fail "$APP_DIR/$f is owned by $(stat -c %U "$APP_DIR/$f"), not $OWNER who owns the checkout. Fix with: sudo chown -R $OWNER $APP_DIR/$f"
  fi
done

branch=$(git_ symbolic-ref --short -q HEAD) || fail "The VM's checkout is on a detached HEAD; expected the main branch"
[ "$branch" = main ] || fail "The VM's checkout is on branch '$branch'; expected main"
if [ -n "$(git_ status --porcelain --untracked-files=no)" ]; then
  git_ status --short --untracked-files=no
  fail "Tracked files were changed by hand on the VM (above). Commit or discard them first."
fi

log "Fetching origin/main"
git_ fetch --quiet origin main
git_ cat-file -e "$TARGET^{commit}" 2>/dev/null || fail "$TARGET isn't on GitHub's main branch"
git_ merge-base --is-ancestor "$TARGET" origin/main || fail "$TARGET isn't merged into main"

PREV=$(git_ rev-parse HEAD)
log "Running now: $(git_ log -1 --format='%h %s' "$PREV")"
log "Deploying:   $(git_ log -1 --format='%h %s' "$TARGET")"

ORIG_APPS=$(pm2_apps) || fail "Couldn't list PM2 apps"
if [ -z "$ORIG_APPS" ] && ! git_ cat-file -e "$TARGET:ecosystem.config.js" 2>/dev/null; then
  fail "No PM2 app runs from $APP_DIR, so I can't tell how to restart the server. Start it by hand once, then retry."
fi
printf '%s\n' "$ORIG_APPS" | cut -f1-3 | sed 's/^/[deploy] PM2 before: /'

CUR_NODE=$(node -v)
CUR_MAJOR=$(node_major)
while IFS=$'\t' read -r name _ _ major _ _; do
  if [ -n "$major" ] && [ "$major" != "$CUR_MAJOR" ]; then
    fail "PM2 runs '$name' on Node $major but $(id -un)'s shell has Node $CUR_MAJOR ($(command -v node)). Make them match first, or native modules would be built for the wrong Node."
  fi
done <<<"$ORIG_APPS"

WANT_NODE=$(git_ show "$TARGET:.nvmrc" 2>/dev/null | tr -d '[:space:]v' || true)
SWITCH_NODE=no
if [ -n "$WANT_NODE" ] && [ "${WANT_NODE%%.*}" != "$CUR_MAJOR" ]; then
  [ "$HAS_NVM" = yes ] ||
    fail "This commit needs Node $WANT_NODE but the VM has $CUR_NODE, installed without nvm. Upgrade Node by hand (see the steps in PR #3), then retry."
  SWITCH_NODE=yes
  PM2_VERSION=$(pm2_ --version 2>/dev/null | tail -n1)
  log "Will switch Node $CUR_NODE -> $WANT_NODE with nvm"
fi

db=$APP_DIR/yjs.db
db_kb=0
[ -f "$db" ] && db_kb=$(($(as_root du -sk "$db" | cut -f1)))
free_kb=$(df -Pk "$APP_DIR" | awk 'NR==2 {print $4}')
need_kb=$((db_kb + 1024 * 1024))
[ "$free_kb" -ge "$need_kb" ] ||
  fail "Only $((free_kb / 1024))MB free on the VM's disk; need $((need_kb / 1024))MB for a database backup and npm ci"

# Back up the database with SQLite's online backup, which is safe while the
# server is writing to it
if [ -f "$db" ]; then
  mkdir -p "$BACKUP_DIR"
  backup=$BACKUP_DIR/yjs-$(date -u +%Y%m%dT%H%M%SZ)-${PREV:0:7}.db
  log "Backing up yjs.db to $backup"
  as_root node -e '
    const [dir, src, dest] = process.argv.slice(1);
    const Database = require(require("path").join(dir, "node_modules/better-sqlite3"));
    const db = new Database(src, { readonly: true, fileMustExist: true });
    db.backup(dest).then(() => db.close(), (e) => { console.error(e.message); process.exit(1); });
  ' "$APP_DIR" "$db" "$backup" || fail "Couldn't back up yjs.db, so nothing was changed"
  as_root chown "$(id -un)" "$backup"
  # Keep the newest few
  find "$BACKUP_DIR" -maxdepth 1 -name 'yjs-*.db' -printf '%T@ %p\n' | sort -rn |
    tail -n +$((KEEP_BACKUPS + 1)) | cut -d' ' -f2- | xargs -r rm -f --
else
  log "No yjs.db yet, skipping the backup"
fi

#
# Point of no return. Each phase runs in a subshell with set -e (outside of an
# `if` or `||`, where bash would ignore set -e), so a failure in any step
# lands here and triggers the rollback. The subshell also keeps nvm's PATH
# change out of this shell, so the rollback runs on the old Node.
#

deploy() {
  log "Checking out $TARGET"
  git_ reset --quiet --hard "$TARGET"
  if [ "$SWITCH_NODE" = yes ]; then
    nvm_ install "$WANT_NODE"
    nvm_ alias default "$WANT_NODE"
    command -v pm2 >/dev/null || npm install -g "pm2@${PM2_VERSION:-latest}"
    log "Moving the PM2 daemon to Node $(node -v)"
    pm2_ update
  fi
  install_and_build
  restart_app
  health_check
}

rollback() {
  log "Rolling back to $(git_ log -1 --format='%h %s' "$PREV")"
  git_ reset --quiet --hard "$PREV"
  if [ "$SWITCH_NODE" = yes ]; then
    nvm_ alias default "$CUR_NODE"
    log "Moving the PM2 daemon back to Node $(node -v)"
    pm2_ update
  fi
  install_and_build
  restart_app
  health_check
}

set +e
(deploy)
rc=$?
set -e
if [ "$rc" = 0 ]; then
  log "Deployed $(git_ log -1 --format='%h %s' "$TARGET")"
  exit 0
fi

error "Deploy failed. Rolling back."
set +e
(rollback)
rc=$?
set -e
if [ "$rc" = 0 ]; then
  fail "Deploy of ${TARGET:0:7} failed; rolled back to ${PREV:0:7}, which is running and healthy"
fi
fail "Deploy of ${TARGET:0:7} failed AND the rollback to ${PREV:0:7} failed. The server may be down; check it over SSH. Database backup: ${backup:-none}"
