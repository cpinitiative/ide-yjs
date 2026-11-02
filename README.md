(WIP) yjs websocket server for cpinitiative/ide

`HOST=localhost PORT=1234 YPERSISTENCE=ypersistence node index.js` or something


## Running in production

Caddy serves https on :443 (it gets and renews the certificate itself) and proxies to the app on `127.0.0.1:1234`, websockets included. The app runs as the `ideyjs` user under that user's own PM2, never as root:

```sh
npm run build && pm2 start ecosystem.config.js && pm2 save
```

The Caddy config is `deploy/Caddyfile`. `deploy/CADDY.md` has the one-time move from the old setup (root PM2, app on :443, certbot), with rollback, and `deploy/check-permissions.sh` is a read-only check of file ownership and the server setup.

PM2 doesn't restart the server on high memory unless you start it with `YJS_MAX_MEMORY` set (for example `YJS_MAX_MEMORY=1500M`). Open docs are saved whenever the server stops.

## Datadog

A Datadog agent is installed on the VM used to host the YJS server.

## Azure Backup Notes

- I think what we want is azure disk backup (and backup the os disk)
- full vm backup works too, but restoring vm via replacement seems very slow (need to make a backup first). creating a new vm seems to be the way to go
- create new vm, change the IP to be associated with the new VM's network interface, then change that network interface to use the same securiyt group so you can ssh into it
## Node version

Runs on Node 24 (see `.nvmrc`). `npm test` builds the server and runs an end-to-end smoke test against a copy of `dist/` in a temp directory, so it never touches the real `yjs.db`.

After changing Node versions, reinstall with `npm ci` so `better-sqlite3`'s native module is rebuilt for the new Node, and restart PM2's daemon with `pm2 update` (as `ideyjs`) so it runs on the new Node too.
