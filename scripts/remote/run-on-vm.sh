#!/usr/bin/env bash
# Runs one of the scripts in this folder on the IDE VM over SSH. Used by the
# "IDE server status" and "Deploy IDE server" workflows (see DEPLOYING.md).
#
#   run-on-vm.sh <script> [args...]
#
# Reads the connection details from IDE_SSH_HOST, IDE_SSH_USER,
# IDE_SSH_PRIVATE_KEY, IDE_SSH_KNOWN_HOSTS and (optionally) IDE_SSH_PORT. The
# key only ever lives in a temp dir that is deleted on exit.
set -euo pipefail

script=$1
shift

for var in IDE_SSH_HOST IDE_SSH_USER IDE_SSH_PRIVATE_KEY IDE_SSH_KNOWN_HOSTS; do
  if [ -z "${!var:-}" ]; then
    echo "::error::$var is not set. Add it as a secret on this workflow's environment (see DEPLOYING.md)."
    exit 1
  fi
done

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$IDE_SSH_PRIVATE_KEY" >"$tmp/key"
printf '%s\n' "$IDE_SSH_KNOWN_HOSTS" >"$tmp/known_hosts"

# Strict host key checking against the pinned known_hosts, so a spoofed host
# can't receive the commands. BatchMode makes a bad key fail instead of hang.
ssh \
  -i "$tmp/key" \
  -p "${IDE_SSH_PORT:-22}" \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$tmp/known_hosts" \
  -o GlobalKnownHostsFile=/dev/null \
  -o ConnectTimeout=20 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=8 \
  "$IDE_SSH_USER@$IDE_SSH_HOST" \
  "bash -s -- $(printf '%q ' "$@")" <"$script"
