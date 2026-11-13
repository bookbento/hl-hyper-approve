// pm2 config for the DEV server (43.210.109.106, /var/www/hlememo-dev) — see scripts/deploy-dev.sh.
//
// Differs from ecosystem.config.js on purpose:
//   - port 3011: 3001 is taken on that box (foodreview-api container)
//   - NODE_ENV=development: the dev box is served over plain HTTP by IP, and the auth
//     cookie is `secure` in production, so login would not stick. development also
//     registers the admin-only /api/dev/expiry/* helpers, which is what a dev box wants.
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'hlememo-dev-api',
      cwd: __dirname, // pdf.core resolves fonts/ from cwd
      script: 'dist/main.js',
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1, // memo-expiry cron runs in-process
      autorestart: true,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'development',
        PORT: '3011',
      },
      out_file: path.join(__dirname, 'logs', 'api.out.log'),
      error_file: path.join(__dirname, 'logs', 'api.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
