# Stage 1: deps - Install dependencies
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/crypto/package.json packages/crypto/
COPY packages/storage/package.json packages/storage/
COPY packages/auth/package.json packages/auth/
COPY packages/stacks/package.json packages/stacks/
COPY packages/updates/package.json packages/updates/
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile

# Stage 2: build - Compile the server
FROM deps AS build
COPY tsconfig.json biome.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/
RUN bun build apps/server/src/index.ts --compile --outfile=/strata

# Stage 3: runtime - Minimal runtime image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /strata /strata
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -sf http://localhost:8080/healthz || exit 1
ENTRYPOINT ["/strata"]
