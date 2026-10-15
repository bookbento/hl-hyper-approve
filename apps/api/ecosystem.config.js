// pm2 config for the NestJS API (replaces backend/ecosystem.config.js → hlememo-backend).
//
//   pm2 startOrReload apps/api/ecosystem.config.js --update-env
//
// Env comes from apps/api/.env via Node's --env-file (no dotenv in the code).
// Variables set in `env` below win over .env (Node never overrides existing env).
// Keep ONE instance: the memo-expiry cron runs in-process and would send
// every reminder twice with two.
const path = require('path');

const logs = process.env.HLEMEMO_LOG_DIR || path.join(__dirname, 'logs');

module.exports = {
  apps: [
    {
      name: 'hlememo-api',
      cwd: __dirname, // pdf.core resolves fonts/ from cwd
      script: 'dist/main.js',
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '768M',
      kill_timeout: 10000, // let enableShutdownHooks close the Prisma pool
      env: {
        NODE_ENV: 'production',
        PORT: '3001', // nginx upstream hlememo_backend
      },
      out_file: path.join(logs, 'hlememo-api.out.log'),
      error_file: path.join(logs, 'hlememo-api.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
