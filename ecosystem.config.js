// PM2 config. Run it as the ideyjs user, not root (see deploy/CADDY.md):
//   npm run build && pm2 start ecosystem.config.js && pm2 save
//
// The app serves plain http on 127.0.0.1:1234. Caddy (deploy/Caddyfile)
// serves https on :443 and proxies to it, so the app needs no root and no
// access to certificates.
//
// Runs node directly (not through npm) so PM2 tracks the server's own
// process. On stop/restart the server saves all open docs before exiting
// (see index.ts).
if (process.getuid && process.getuid() === 0) {
  throw new Error(
    "Don't run the IDE server as root. Run pm2 as the ideyjs user (see deploy/CADDY.md)."
  );
}

module.exports = {
  apps: [
    {
      name: "ide-yjs",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        // Only reachable through Caddy. Must match reverse_proxy in
        // deploy/Caddyfile. These win over HOST/PORT in .env.
        HOST: "127.0.0.1",
        PORT: "1234",
      },
      // No automatic memory restart by default. To turn one on, start with
      // e.g. YJS_MAX_MEMORY=1500M pm2 start ecosystem.config.js
      ...(process.env.YJS_MAX_MEMORY
        ? { max_memory_restart: process.env.YJS_MAX_MEMORY }
        : {}),
      // Give the server time to save open docs before PM2 force-kills it
      kill_timeout: 10000,
      // Back off if it keeps crashing on startup
      exp_backoff_restart_delay: 1000,
    },
  ],
};
