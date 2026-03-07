FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY web/package.json web/bun.lock ./
COPY web/apps/ui/package.json apps/ui/package.json
COPY web/apps/api/package.json apps/api/package.json

# Install deps (need @strata/api for type imports)
RUN bun install --frozen-lockfile

# Copy source
COPY web/tsconfig.json ./tsconfig.json
COPY web/apps/api/ apps/api/
COPY web/apps/ui/ apps/ui/

# Build
WORKDIR /app/apps/ui
ARG VITE_API_URL=""
RUN bun run build

FROM scratch
COPY --from=builder /app/apps/ui/dist /dist
