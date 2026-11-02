# Moving to Caddy and a non-root app

Before: the Node app ran as root under root's PM2, listened on :443 itself and
read the certbot certificate from `/etc/letsencrypt`.

After: Caddy listens on :80 and :443, gets and renews the certificate itself,
and proxies to the app on `127.0.0.1:1234`. The app runs as `ideyjs` under
that user's own PM2. Certbot is retired.

Paths below assume the checkout is `/home/ideyjs/ide-yjs` and the root PM2
app is named `ide-yjs` (use the name `sudo pm2 ls` shows). If `sudo` can't
find `pm2` or `node`, run those commands from `sudo -i` instead.

## 0. Check first (read-only)

```sh
sudo bash deploy/check-permissions.sh
```

It shows who runs the app, what root owns in the checkout, whether `ideyjs`
has a working Node 24 and PM2, the certbot renewal setup and open ports.

## 1. Prepare (no downtime, the server keeps running)

1. **Firewall.** The Azure NSG must allow inbound TCP 443 (already open) and
   TCP 80 (for the http to https redirect and Let's Encrypt's http check).
   If `ufw` is active: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`.
   Port 1234 should not be open to the internet.

2. **Node and PM2 for ideyjs.** If the check shows `ideyjs` has no Node 24
   (for example Node lives under `/root/.nvm`, which other users can't
   read), install it for `ideyjs`:

   ```sh
   sudo -iu ideyjs
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   . ~/.nvm/nvm.sh && nvm install 24 && npm install -g pm2
   exit
   ```

   Any Node 24.x works with the existing `node_modules` (`better-sqlite3`'s
   native module only cares about the major version).

3. **PM2 at boot for ideyjs.** As `ideyjs`, run `pm2 startup systemd`; it
   prints one `sudo env PATH=... pm2 startup ...` line. Run that line from a
   sudo-capable user. It adds `pm2-ideyjs.service`, which starts nothing until
   step 2.5 saves the app.

4. **Back up the database.**

   ```sh
   cd /home/ideyjs/ide-yjs
   sudo node -e 'require("./node_modules/better-sqlite3")("yjs.db").backup("/home/ideyjs/yjs-pre-caddy.db").then(()=>console.log("backup ok"))'
   ```

   (Use the full path to `node` if `sudo` can't find it.)

5. **Install Caddy** from its official apt repo, then keep it off until the
   cutover so it can't grab :443 if the VM reboots first:

   ```sh
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   sudo systemctl disable --now caddy
   sudo cp /home/ideyjs/ide-yjs/deploy/Caddyfile /etc/caddy/Caddyfile
   caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   (Get the Caddyfile from this branch if the checkout isn't on it yet.)

## 2. Cutover (downtime: about 2 to 5 minutes)

Editors reconnect by themselves when the server is back.

1. **Stop the root app.** Keep a copy of root's PM2 list for rollback:

   ```sh
   sudo pm2 ls
   sudo cp /root/.pm2/dump.pm2 /root/.pm2/dump.pm2.pre-caddy
   sudo pm2 stop ide-yjs     # saves open docs on the way out
   sudo pm2 delete ide-yjs && sudo pm2 save
   ```

   If `pm2 ls` showed nothing else under root, also
   `sudo pm2 kill && sudo systemctl disable pm2-root`.

2. **Hand the files to ideyjs.**

   ```sh
   sudo chown -R ideyjs:ideyjs /home/ideyjs/ide-yjs
   ```

   Also chown anything else the check listed under `/home/ideyjs` (for
   example a root-owned `~/.npm` or `~/.pm2`).

3. **Update the code and build, as ideyjs.** `node_modules` doesn't need
   reinstalling because this change adds no dependencies.

   ```sh
   sudo -iu ideyjs
   cd ~/ide-yjs
   git fetch origin && git checkout <this commit or main after merge>
   npm run build
   ```

4. **Start it as ideyjs** and check it locally:

   ```sh
   pm2 start ecosystem.config.js && pm2 save
   curl -s http://127.0.0.1:1234/      # Hello!
   exit
   ```

5. **Start Caddy**, which gets the certificate in a few seconds:

   ```sh
   sudo systemctl enable --now caddy
   sudo journalctl -u caddy -f        # wait for "certificate obtained successfully"
   ```

6. **Verify** (from your laptop or the VM):

   ```sh
   curl -s https://yjs.usaco.guide/                 # Hello!
   curl -sI http://yjs.usaco.guide/ | head -3       # 308 to https
   echo | openssl s_client -connect yjs.usaco.guide:443 -servername yjs.usaco.guide 2>/dev/null | openssl x509 -noout -issuer -enddate
   curl -si --http1.1 --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     https://yjs.usaco.guide/caddy-check | head -1  # HTTP/1.1 101 Switching Protocols
   sudo ss -ltnp | grep -E ':(80|443|1234)\b'     # caddy on 80/443, node on 127.0.0.1:1234
   ps -o user=,args= -C node                        # ideyjs ... dist/index.js
   ```

   (The websocket check leaves a tiny empty doc named `caddy-check`.) Then
   open the IDE in two tabs and check an edit syncs.

## 3. Retire certbot (once Caddy is serving)

Turn off renewal but leave the files, so rollback still has a valid cert:

```sh
sudo systemctl disable --now certbot.timer 2>/dev/null   # apt certbot
sudo snap stop --disable certbot.renew 2>/dev/null       # snap certbot
```

Also comment out any certbot line in `/etc/cron.d/certbot` or root's crontab,
and move any hook in `/etc/letsencrypt/renewal-hooks/` that restarts the app
out of the way. After a couple of weeks with no problems:
`sudo certbot delete --cert-name yjs.usaco.guide`, then remove the certbot
package.

## Rollback

Works as long as the old certificate is still valid (it was renewed by
certbot until the cutover).

```sh
sudo systemctl disable --now caddy
sudo -iu ideyjs bash -c 'pm2 delete ide-yjs; pm2 save; cd ~/ide-yjs && git checkout 5a0d143 && npm run build'
sudo cp /root/.pm2/dump.pm2.pre-caddy /root/.pm2/dump.pm2
sudo pm2 resurrect && sudo systemctl enable pm2-root
sudo systemctl enable --now certbot.timer 2>/dev/null || sudo snap start --enable certbot.renew
curl -s https://yjs.usaco.guide/   # Hello!
```

Root can run the app on files owned by `ideyjs`, so no chown is needed to go
back. Only restore `/home/ideyjs/yjs-pre-caddy.db` if docs look wrong: stop
the app first, then copy it over `yjs.db` and delete `yjs.db-wal` and
`yjs.db-shm`.

## Later

A reboot (for example for the next kernel update) is a good check that both
`caddy` and `pm2-ideyjs` come back by themselves.
