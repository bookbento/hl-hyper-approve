module.exports = {
  apps: [{
    name: "hlememo-backend",
    cwd: "/var/www/hlememo/backend",
    script: "./dist/src/index.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    max_memory_restart: "768M",
    env: { NODE_ENV: "production" },
    out_file: "/var/www/hlememo/backend/logs/hlememo-backend.out.log",
    error_file: "/var/www/hlememo/backend/logs/hlememo-backend.err.log",
    merge_logs: true,
    time: true
  }]
};
