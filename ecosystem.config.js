// PM2 config. Start with: npm run build && sudo pm2 start ecosystem.config.js
//
// Runs node directly (not through npm) so PM2 measures the server's own
// memory, and restarts it automatically if it goes over max_memory_restart.
// On restart the server saves all open docs before exiting (see index.ts).
module.exports = {
  apps: [
    {
      name: "ide-yjs",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      // Set this below the VM's RAM, leaving room for the OS and the Datadog
      // agent. Override with YJS_MAX_MEMORY, e.g. YJS_MAX_MEMORY=1500M.
      max_memory_restart: process.env.YJS_MAX_MEMORY || "1G",
      // Give the server time to save open docs before PM2 force-kills it
      kill_timeout: 10000,
      // Back off if it keeps crashing on startup
      exp_backoff_restart_delay: 1000,
    },
  ],
};
