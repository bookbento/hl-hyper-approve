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
export API_DIR="$APP_ROOT/apps/api"
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
sudo mkdir -p "$APP_ROOT"/{logs,uploads}
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


# Write apps/api/.env (production) — read by node --env-file (apps/api/ecosystem.config.js).
# Template with every variable: apps/api/env-example.txt
mkdir -p "$API_DIR"
cd "$API_DIR"
if [ ! -f .env ]; then
cat > .env <<EOF2
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
NODE_ENV=production
PORT=${APP_PORT}
TRUST_PROXY_HOPS=1
JWT_SECRET=$(openssl rand -hex 32)
EMAIL_TOKEN_SECRET=$(openssl rand -hex 32)
APP_BASE_URL=https://${DOMAIN}
FRONTEND_URL=https://${DOMAIN}
CORS_ORIGIN=https://${DOMAIN}
UPLOADS_DIR=${UPLOAD_DIR}
# Fill these in before starting the API (it refuses to boot without SMTP_HOST/SMTP_FROM)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
EOF2
chmod 600 .env
fi

printStep "[4/7] Installing + building the monorepo..."

cd "$APP_ROOT"
corepack enable || sudo npm install -g corepack
# @hl/database postinstall: prisma generate + build
CI=1 corepack pnpm install --frozen-lockfile

# Schema: fresh DB → migrations from packages/database, then lookup data.
# (Never `migrate reset` here — it drops the database.)
set -a; . "$API_DIR/.env"; set +a
corepack pnpm db:migrate
corepack pnpm db:seed
corepack pnpm db:init-preferences

corepack pnpm --filter apps/api build
corepack pnpm --filter my-react-app build

printStep "[5/7] Starting the API with PM2..."

mkdir -p "$API_DIR/logs"
cd "$API_DIR"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save || { echo "Failed to save PM2 process list";  }
pm2 startup systemd -u "$USER" --hp "$HOME" || true

# Quick health check (direct to Node)
echo "Checking API health..."
sleep 3
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


printStep "[7/7] Redeploy"
# Builds, migrations and the pm2 reload for later releases live in deploy-production.sh.
cd "$APP_ROOT"
echo "Run: sudo ./deploy-production.sh"

printStep "[7/7] Frontend fallback for Apache..."
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


################################################################################
# Ops notes from the Express era (backend/ no longer exists — see deploy-production.sh).
# Not meant to run top to bottom. Do NOT run the old "migrate reset" lines: they drop the DB.
################################################################################





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


