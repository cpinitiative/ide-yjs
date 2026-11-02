(WIP) yjs websocket server for cpinitiative/ide

`HOST=localhost PORT=1234 YPERSISTENCE=ypersistence node index.js` or something


PM2 command: `npm run build && sudo pm2 start ecosystem.config.js`

This restarts the server automatically if its memory goes over `max_memory_restart` (default 1G; set `YJS_MAX_MEMORY` to change it). Open docs are saved before each restart.

(Previously: `sudo pm2 start npm -- start`. Running through npm means PM2 only sees npm's memory, so the memory limit wouldn't work.)

## Datadog

A Datadog agent is installed on the VM used to host the YJS server.

## Azure Backup Notes

- I think what we want is azure disk backup (and backup the os disk)
- full vm backup works too, but restoring vm via replacement seems very slow (need to make a backup first). creating a new vm seems to be the way to go
- create new vm, change the IP to be associated with the new VM's network interface, then change that network interface to use the same securiyt group so you can ssh into it