FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy workspace root + all workspace package.json files (lockfile requires all)
COPY web/package.json web/bun.lock ./
COPY web/apps/api/package.json apps/api/package.json
COPY web/apps/ui/package.json apps/ui/package.json

# Install deps (frozen lockfile requires all workspace entries present)
RUN bun install --frozen-lockfile

# Copy API source only
COPY web/apps/api/ apps/api/

# Build standalone binary
WORKDIR /app/apps/api
RUN bun build src/index.ts --compile --outfile /strata-web

FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=builder /strata-web /strata-web

EXPOSE 3000

CMD ["/strata-web"]
