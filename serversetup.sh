#!/bin/bash

# ===== variables you set once =====


# Function for progress messages
printStep() {
  echo "\n[$(date '+%H:%M:%S')] $1\n"
}

# Server IP and domain setup
export IP="43.209.134.154"
# export DOMAIN="hlememo.${IP}.nip.io"
export DOMAIN="ememo.hylifeconnect.com"



# DB
export DB_USER="hlememouser"
export DB_PASS="HlEpass2025x"
export DB_NAME="hlememo"

# Paths / ports
export APP_ROOT="/var/www/hlememo"
export BACKEND_DIR="$APP_ROOT/backend"
export FRONTEND_DIR="$APP_ROOT/frontend"
export APP_PORT="3001"
export LOG_DIR="$APP_ROOT/logs"
export UPLOAD_DIR="$APP_ROOT/uploads"




printStep "[1/7] Installing system dependencies..."

# System updates + basics
sudo apt update -y && sudo apt upgrade -y || { echo "Failed to update system packages";  }
sudo apt install -y tzdata locales unattended-upgrades curl gnupg ca-certificates \
  software-properties-common ufw p7zip-full zip unzip build-essential openssl || { echo "Failed to install system dependencies";  }

# Timezone + locale
sudo timedatectl set-timezone Asia/Bangkok
sudo locale-gen en_US.UTF-8

# Node.js 22 + PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs || { echo "Failed to install Node.js";  }
sudo npm install -g pm2@latest || { echo "Failed to install PM2";  }

# PostgreSQL 16 repo + install
sudo install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 | sudo tee /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc >/dev/null
source /etc/os-release
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
 | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
sudo apt update -y
sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql

printStep "[2/7] Creating application directories..."

# App folders with proper permissions
sudo mkdir -p "$APP_ROOT"/{backend,frontend,logs,uploads}
sudo chown -R "$USER":"$USER" "$APP_ROOT"
sudo chmod -R 755 "$APP_ROOT"
sudo chmod -R 775 "$UPLOAD_DIR" # Ensure uploads directory is writable




printStep "[3/7] Setting up PostgreSQL database..."

# Check if PostgreSQL is running
if ! systemctl is-active --quiet postgresql; then
  echo "PostgreSQL service is not running. Starting now..."
  sudo systemctl start postgresql || { echo "Failed to start PostgreSQL";  }
fi

# Create role if it doesn't exist
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
sudo -u postgres psql -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}'"

# Set sensible defaults for that role (safe to re-run)
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "
ALTER ROLE ${DB_USER} SET client_encoding TO 'utf8';
ALTER ROLE ${DB_USER} SET default_transaction_isolation TO 'read committed';
ALTER ROLE ${DB_USER} SET timezone TO 'Asia/Bangkok';"

# If DB doesn't exist, create it and set owner
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE \"${DB_NAME}\" TO \"${DB_USER}\""


# Write backend .env (production)
cd "$BACKEND_DIR"
export JWT_SECRET="$(openssl rand -hex 32)"
cat > .env <<EOF
# Database
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}

# Server
PORT=${APP_PORT}
NODE_ENV=production
HOST=127.0.0.1

# CORS (same-origin + IP + local dev)
CORS_ORIGIN=http://${DOMAIN},http://${IP},http://localhost:5173

# JWT
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d
ACCESS_TOKEN_EXPIRES_IN=7d

# File Upload
MAX_FILE_SIZE=104857600
UPLOAD_PATH=./uploads
ALLOWED_FILE_TYPES=pdf,jpg,jpeg,png,heic

# Optional email/LINE
EMAIL_FROM=
EMAIL_HOST=
EMAIL_PORT=587
EMAIL_USER=
EMAIL_PASS=
LINE_NOTIFY_TOKEN=

# Security
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
EOF

printStep "[4/7] Setting up backend application..."

# Create logs directory with appropriate permissions
mkdir -p "$BACKEND_DIR/logs"
touch "$BACKEND_DIR/logs/app.log"
chmod 755 "$BACKEND_DIR/logs"
chmod 644 "$BACKEND_DIR/logs/app.log"

# Install deps, generate client, migrate, seed (if scripts exist)
npm ci || npm install || { echo "Failed to install npm dependencies";  }
rm -rf prisma/migrations
npx prisma migrate reset --force --skip-generate
npx prisma db push
npm run db:seed    

# Build backend for production
echo "Building backend for production..."
npm run build || { echo "Failed to build backend. Check if build script exists in package.json";  }




printStep "[5/7] Starting backend with PM2..."


# Ensure PM2 is installed
if ! command -v pm2 >/dev/null; then
  echo "PM2 is not installed. Installing..."
  sudo npm install -g pm2@latest || { echo "Failed to install PM2";  }
fi

if pm2 describe hlememo-backend > /dev/null; then
  pm2 restart hlememo-backend --update-env
else
  pm2 start npm --name "hlememo-backend" -- run start
fi

pm2 save







APP_NAME="hlememo-backend"
CWD="$(pwd)"

# Detect the compiled entry
if [ -f "dist/index.js" ]; then
  ENTRY="./dist/index.js"
elif [ -f "dist/src/index.js" ]; then
  ENTRY="./dist/src/index.js"
elif [ -f "dist/src/app.js" ]; then
  ENTRY="./dist/src/app.js"
else
  echo "❌ Could not find a compiled entry (dist/index.js or dist/src/index.js). Did you run: npm run build ?"
  exit 1
fi

# Create PM2 ecosystem config
cat > ecosystem.config.js <<EOL
module.exports = {
  apps: [{
    name: "hlememo-backend",
    cwd: "/var/www/hlememo/backend",
    script: "./dist/src/index.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    max_memory_restart: "300M",
    env: { NODE_ENV: "production" },
    out_file: "/var/www/hlememo/backend/logs/hlememo-backend.out.log",
    error_file: "/var/www/hlememo/backend/logs/hlememo-backend.err.log",
    merge_logs: true,
    time: true
  }]
};
EOL

# Make sure logs dir exists
mkdir -p logs

# Start/reload and persist
if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save || { echo "Failed to save PM2 process list";  }

echo "✅ PM2 is running ${APP_NAME} with entry: ${ENTRY}"


# Quick health check (direct to Node)
echo "Checking backend health..."
sleep 2 # Give service time to start
curl -i "http://127.0.0.1:${APP_PORT}/api/health" || echo "Warning: Backend health check failed. Check if the service is running."















printStep "[6/7] Setting up Nginx and PHP..."

# Install Nginx + PHP-FPM + Adminer
sudo apt install -y nginx php-fpm php-cli php-pgsql adminer || { echo "Failed to install Nginx and PHP components";  }

# Configure basic firewall rules
echo "Configuring firewall..."
sudo ufw allow 'Nginx Full' || echo "Warning: Failed to configure firewall for Nginx"
sudo ufw allow ssh || echo "Warning: Failed to configure firewall for SSH"
sudo ufw allow 80/tcp || echo "Warning: Failed to configure firewall for HTTP"
sudo ufw --force enable || echo "Warning: Failed to enable firewall"

# Adminer (optional) at /adminer
sudo ln -sf /usr/share/adminer/adminer.php /usr/share/adminer/index.php

# Auto-detect PHP-FPM socket (fallback to php8.1)
PHP_FPM_SOCK="$(find /run/php -maxdepth 1 -name 'php*-fpm.sock' | head -n1)"
PHP_FPM_SOCK="${PHP_FPM_SOCK:-/run/php/php8.3-fpm.sock}"

# Nginx server block (HTTP only; domain + raw IP; SPA + /api proxy; /api/health -> /health)
sudo tee /etc/nginx/sites-available/hlememo >/dev/null <<'NGINX'
# /etc/nginx/sites-available/hlememo

# Upstream — Node backend
upstream hlememo_backend {
    server 127.0.0.1:3001;
    keepalive 32;
}

########################
# :80 → force to HTTPS
########################
server {
    listen 80;
    listen [::]:80;
    server_name ememo.hylifeconnect.com;

    # ACME challenge
    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    # Redirect all HTTP to HTTPS
    return 301 https://$host$request_uri;
}

########################
# :443 — main site
########################
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ememo.hylifeconnect.com;

    ssl_certificate     /etc/letsencrypt/live/ememo.hylifeconnect.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ememo.hylifeconnect.com/privkey.pem;

    # TLS sane defaults
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # Frontend (SPA)
    root /var/www/hlememo/frontend/dist;
    index index.html;
    client_max_body_size 100M;


    # SPA fallback (NO redirects here)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API
    location /api/ {
        proxy_pass http://hlememo_backend;
        proxy_http_version 1.1;
        client_max_body_size 100M;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_cache_bypass $http_upgrade;
    }

    # Health
    location = /api/health {
        proxy_pass http://hlememo_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_cache_bypass $http_upgrade;
    }

    # Primary uploads path - use the root uploads directory
    location /uploads/ {
        alias /var/www/hlememo/uploads/;
        client_max_body_size 100M;
        # cache for a year
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Secondary path - direct access to source uploads in case files are stored there
    location /source-uploads/ {
        # Internal redirect to handle src/uploads path
        alias /var/www/hlememo/backend/src/uploads/;
        client_max_body_size 100M;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
 
}
NGINX

# Ensure only this site is enabled
sudo ln -sf /etc/nginx/sites-available/hlememo /etc/nginx/sites-enabled/hlememo

# Disable the default site if it exists
[ -e /etc/nginx/sites-enabled/default ] && sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx


printStep "[7/7.1] Build + Migrate backend"
cd "$BACKEND_DIR"

npx prisma generate
npx prisma migrate deploy
npm run db:seed || echo "No seed script found or seeding failed, continuing..."

echo "Building backend for production..."
npm run build || { echo "Failed to build backend. Check if build script exists in package.json";  }

printStep "[7/7.2] Build frontend"
cd "$FRONTEND_DIR"
npm run build || { echo "Failed to build frontend application";  }

# (ถ้าอยาก) reload nginx ให้หยิบไฟล์ใหม่ทันที
sudo systemctl reload nginx || true

printStep "[7/7.3] Start/Reload backend with PM2"
cd "$BACKEND_DIR"
APP_NAME="hlememo-backend"
ECOS="$BACKEND_DIR/ecosystem.config.js"



# start หรือ reload
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$ECOS" --update-env
else
  pm2 start "$ECOS"
fi
pm2 save || { echo "Failed to save PM2 process list";  }

# Health check ตรงไปที่ Node (ไม่ผ่าน nginx)
sleep 2
curl -fsSI "http://127.0.0.1:${APP_PORT}/api/health" || echo "Health check failed (check PM2 logs)"
pm2 status "$APP_NAME"



printStep "[7/7] Building frontend application..."

# Make frontend use relative /api (no localhost in bundle)
cd "$FRONTEND_DIR"
grep -Rlz "http://localhost:3001/api\|https://localhost:3001/api\|http://127.0.0.1:3001/api" src \
  | xargs -0 -r sed -i -E 's#https?://(localhost|127\.0\.0\.1):3001/api#/api#g'







# Remove env files so build doesn't inject stale API URLs
rm -f .env .env.production .env.development .env.local || true

# Build frontend
npm ci || npm install || { echo "Failed to install frontend dependencies";  }
npm run build || { echo "Failed to build frontend application";  }


# Reload Nginx to pick up new static files
sudo systemctl reload nginx

printStep "Running smoke tests..."

# Check if nginx is running properly
if ! systemctl is-active --quiet nginx; then
  echo "Warning: Nginx is not running. Attempting to start..."
  sudo systemctl start nginx
fi



# Create a .htaccess file for SPA routing fallback (if Apache is used instead of Nginx)
cat > "${FRONTEND_DIR}/dist/.htaccess" <<EOL
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
EOL

# Reload Nginx to pick up new static files
sudo systemctl reload nginx

printStep "Running smoke tests..."

# Check if nginx is running properly
if ! systemctl is-active --quiet nginx; then
  echo "Warning: Nginx is not running. Attempting to start..."
  sudo systemctl start nginx
fi

# Smoke tests via domain and raw IP
echo "Testing API health endpoint..."
sleep 5 # Give services time to start up
curl -I "http://${DOMAIN}/api/health" || echo "Warning: Health check via domain failed. This might be expected if DNS hasn't propagated."
curl -I "http://${IP}/api/health" || echo "Warning: Health check via IP failed. Check if the service is running and the firewall allows traffic."

echo "===========================================================" 
echo "Setup completed! You can access the application at:"  
echo "  http://${DOMAIN}/"  
echo "  http://${IP}/"  
echo "==========================================================="






sudo nginx -t && sudo systemctl reload nginx
curl -I http://${DOMAIN}/adminer/
curl -I http://${DOMAIN}/adminer/adminer.php








# Install Certbot for Nginx
sudo apt update
sudo apt install -y certbot python3-certbot-nginx

# Issue and auto-configure HTTPS for your domain
sudo certbot --nginx -d ememo.hylifeconnect.com

# Test auto-renewal
sudo certbot renew --dry-run




Quick WS test (no install)
npx wscat -c wss://ememo.hylifeconnect.com/ws

Or install globally
sudo npm i -g wscat
wscat -c wss://ememo.hylifeconnect.com/ws



FILE=/etc/nginx/sites-available/hlememo

echo "[Check] Redirects on 443 (should be none except /adminer -> /adminer/)"
sudo nginx -T | awk '
/server\s*{/ {blk=1; buf=$0 ORS; next}
blk {buf=buf $0 ORS}
blk && /}/ {
  if (buf ~ /listen .*443/ && buf ~ /server_name[^\n]*ememo\.hylifeconnect\.com/ && buf ~ /return 301/ && buf !~ /location = \/adminer/) print buf "\n-----";
  blk=0; buf=""
}'

echo "[Check] Empty headers (means $vars got stripped)"
grep -nE 'proxy_set_header [A-Za-z-]+ *;|proxy_cache_bypass *;' "$FILE" || echo "OK"

echo "[Check] SPA try_files has \$uri"
grep -n 'try_files' "$FILE"










Adminer access

cd /usr/share/adminer
php -S 0.0.0.0:8080


http://43.209.134.154:8080/index.php



psql --dbname="postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo" < /var/www/hlememo/backend/backup.sql


psql --dbname="postgresql://hlememouser:HlEpass2025x@localhost:5432/postgres" -c "DROP DATABASE hlememo;"
psql --dbname="postgresql://hlememouser:HlEpass2025x@localhost:5432/postgres" -c "CREATE DATABASE hlememo;"
psql --dbname="postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo" < /var/www/hlememo/backend/backup.sql














# Function for progress messages
printStep() {
  echo "\n[$(date '+%H:%M:%S')] $1\n"
}

# Server IP and domain setup
export IP="43.209.134.154"
# export DOMAIN="hlememo.${IP}.nip.io"
export DOMAIN="ememo.hylifeconnect.com"



# DB
export DB_USER="hlememouser"
export DB_PASS="HlEpass2025x"
export DB_NAME="hlememo"

# Paths / ports
export APP_ROOT="/var/www/hlememo"
export BACKEND_DIR="$APP_ROOT/backend"
export FRONTEND_DIR="$APP_ROOT/frontend"
export APP_PORT="3001"
export LOG_DIR="$APP_ROOT/logs"
export UPLOAD_DIR="$APP_ROOT/uploads"


# Write backend .env (production)
cd "$BACKEND_DIR"
npm ci
sudo rm -rf dist
npm run build || { echo "Failed to build backend. Check if build script exists in package.json";  }



if pm2 describe hlememo-backend > /dev/null; then
  pm2 restart hlememo-backend --update-env
else
  pm2 start npm --name "hlememo-backend" -- run start
fi

pm2 save




cd "$FRONTEND_DIR"
npm ci
sudo rm -rf dist

npm run build || { echo "Failed to build frontend application";  }

# Reload Nginx to pick up new static files
sudo systemctl reload nginx

printStep "Running smoke tests..."

# Check if nginx is running properly
if ! systemctl is-active --quiet nginx; then
  echo "Warning: Nginx is not running. Attempting to start..."
  sudo systemctl start nginx
fi






export DATABASE_URL='postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo?schema=public'


pg_dump --dbname="postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo" > /var/www/hlememo/backup.sql
psql --dbname="postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo" < /var/www/hlememo/backup.sql



sudo 7z a -t7z -mx=9 /var/www/hlememo.7z /var/www/hlememo -xr\!node_modules
sudo 7z x /var/www/hlememo.7z -o/var/www/

sudo chmod -R 777 /var/www/hlememo

sudo psql "postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo" -c 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileImagePath" TEXT; ALTER TABLE "User" DROP COLUMN IF EXISTS "profileImage";'



cd "$BACKEND_DIR"

npx prisma migrate reset --force --skip-generate
npx prisma db push
npm run db:seed    



if pm2 describe hlememo-backend > /dev/null; then
  pm2 restart hlememo-backend --update-env
else
  pm2 start npm --name "hlememo-backend" -- run start
fi

pm2 save



pm2 logs hlememo-backend --lines 50


npm run build && pm2 restart hlememo-backend




psql "postgresql://hlememouser:HlEpass2025x@localhost:5432/hlememo" -c "SELECT id, name, \"profileImagePath\" FROM \"User\" WHERE id = 22;"


sudo -u postgres psql -d hlememo -c "SELECT setval('\"MemoType_id_seq\"', COALESCE((SELECT MAX(id) FROM \"MemoType\"), 0) + 1, false);" && cd /var/www/hlememo/backend && pm2 restart hlememo-backend


