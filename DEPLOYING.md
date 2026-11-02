# Checking and deploying the server from GitHub

Two manually triggered workflows manage the VM over SSH, so nobody needs a copy of an SSH key to check on or deploy the server:

- **IDE server status** (`.github/workflows/ide-status.yml`) is read-only. It reports Node and PM2 versions, PM2 app status and restarts, memory, disk, the TLS certificate's expiry and a summary of the last day's errors. The run turns red if the server doesn't answer.
- **Deploy IDE server** (`.github/workflows/ide-deploy.yml`) deploys a commit from `main`. Each run waits for a required reviewer to approve it in GitHub before it touches the VM.

Run either from the repo's Actions tab with "Run workflow". For a deploy, then open the run and approve it under "Review deployments".

## What a deploy does

1. On a GitHub runner, with no secrets: checks the commit is merged into `main`, then runs `npm ci`, `npm run build` and `npm test` (when the commit has tests).
2. Waits for approval.
3. On the VM, before changing anything: refuses to run if the checkout isn't on `main`, has files changed by hand, is missing PM2, is low on disk, or if the Node that PM2 uses doesn't match the shell's. Then backs up `yjs.db` with SQLite's online backup to `~/ide-yjs-backups` (keeps the newest 5).
4. Checks out the commit, switches Node to the version in `.nvmrc` if needed (only when Node is installed with nvm), runs `npm ci` and `npm run build`, and restarts PM2. With `ecosystem.config.js` it starts that and removes the old `pm2 start npm -- start` app; without it, it restarts the existing apps.
5. Checks that `https://yjs.usaco.guide/` answers from the VM and that the app stays up for 20 seconds.
6. If any step after the checkout fails, it goes back to the previous commit (and Node), rebuilds, restarts and health-checks again. The database is never rolled back.

The deploy script always comes from `main`, so you can roll back by deploying an older commit SHA.

It won't install Node itself. If Node came from apt/NodeSource rather than nvm, the first Node major upgrade (like the one in #3) is done by hand.

## Logs stay private

This repo is public, and so are its Actions logs. The scripts never print env vars, `.env` or raw server logs, because log lines can include a doc's name, and a doc's name is enough to open it in the IDE. The status run prints counts of errors and warnings with doc names and long IDs replaced by `<name>` and `<id>`. Read the full logs over SSH.

## One-time setup

1. Make a key just for GitHub Actions, on your own machine:
   ```sh
   ssh-keygen -t ed25519 -N "" -C "github-actions ide-yjs" -f ide-yjs-actions
   ```
2. On the VM, as the user that owns the checkout and has passwordless sudo, add the public key with forwarding turned off:
   ```sh
   echo "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat ide-yjs-actions.pub)" >> ~/.ssh/authorized_keys
   ```
3. Get the VM's host key line from your own `known_hosts` (you've already trusted it by SSHing in):
   ```sh
   ssh-keygen -F <vm host or IP> | grep -v '^#'
   ```
   For a port other than 22, use `ssh-keygen -F '[<host>]:<port>'`.
4. In the repo's Settings → Environments, create two environments. In both, set "Deployment branches and tags" to **Selected branches: `main`** so no other branch can read the secrets, and add these environment secrets:
   - `IDE_SSH_HOST`: the VM's host name or IP, as used in step 3
   - `IDE_SSH_USER`: the user from step 2
   - `IDE_SSH_PRIVATE_KEY`: the contents of `ide-yjs-actions` (the private key)
   - `IDE_SSH_KNOWN_HOSTS`: the line(s) from step 3

   The environments:
   - `ide-status`: no reviewers, so status checks run straight away.
   - `ide-production`: turn on **Required reviewers** and add yourself. Leave "Prevent self-review" off, or you can't approve runs you start.
5. In Settings → Secrets and variables → Actions → Variables, add a repository variable `IDE_APP_DIR` with the checkout's absolute path on the VM. If SSH isn't on port 22, also add `IDE_SSH_PORT`.
6. Delete `ide-yjs-actions` and `ide-yjs-actions.pub` from your machine.
7. Run **IDE server status** once and check its output before the first deploy.

GitHub's runners connect from changing IP addresses, so the VM's network security group has to allow SSH from the internet. With key-only SSH (password login off) that's the usual setup. If SSH is restricted to your own IP, these workflows can't connect until that changes.

To revoke access, remove the key's line from `~/.ssh/authorized_keys` on the VM.
