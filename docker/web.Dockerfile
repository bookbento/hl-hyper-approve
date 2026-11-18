# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f docker/web.Dockerfile -t hyper-web .
#
# Vite SPA baked into Caddy. The same image serves dev (plain HTTP behind the host's
# nginx) and prod (Caddy terminates TLS) — see SITE_ADDRESS / API_UPSTREAM in Caddyfile.

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY frontend/package.json frontend/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter my-react-app...
COPY frontend frontend
# No VITE_BACKEND_API_URL: the SPA calls /api on its own origin (frontend/src/lib/api.ts)
RUN pnpm --filter my-react-app build && test -f frontend/dist/index.html

FROM caddy:2.10-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv
ENV SITE_ADDRESS=:80 \
    API_UPSTREAM=api:3001
