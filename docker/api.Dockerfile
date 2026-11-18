# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f docker/api.Dockerfile -t hyper-api .
#
# Debian slim (not alpine): bcrypt, sharp and the Prisma engine ship glibc prebuilds,
# and builder + runner share the same base so `prisma generate` picks the right engine.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
# frontend is a workspace member; its manifest keeps the lockfile consistent
COPY frontend/package.json frontend/
# @hl/database postinstall runs `prisma generate` + tsc, so it needs schema + sources
COPY packages/database packages/database
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter apps/api... --filter @hl/database

# ---------- builder ----------
FROM base AS builder
COPY --from=deps /app ./
COPY apps/api apps/api
RUN pnpm --filter @hl/database build && pnpm --filter apps/api build \
 && test -f apps/api/dist/main.js

# ---------- runner ----------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3001 \
    UPLOADS_DIR=/data/uploads
# Dev deps stay (prisma CLI) so migrations run from this same image.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
# pdf.core resolves fonts from process.cwd()/fonts
COPY --chown=node:node apps/api/fonts ./apps/api/fonts
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
RUN mkdir -p /data/uploads && chown node:node /data/uploads

# uid 1000 = owner of the uploads folders on the servers (ubuntu)
USER node
WORKDIR /app/apps/api
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
