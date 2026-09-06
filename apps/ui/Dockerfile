# syntax=docker/dockerfile:1
# Stage 1: deps — install workspace dependencies
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Every workspace manifest: @procella/api pulls in audit, esc, github, oidc,
# telemetry and webhooks, so a hand-picked subset breaks workspace resolution.
COPY --parents ./*/*/package.json ./
RUN bun install --frozen-lockfile

# Stage 2: build — compile UI static assets
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ui/ apps/ui/
WORKDIR /app/apps/ui
RUN bun run build

# Stage 3: serve — Caddy static file server with SPA fallback
FROM caddy:2-alpine
COPY --from=build /app/apps/ui/dist /srv
COPY apps/ui/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
