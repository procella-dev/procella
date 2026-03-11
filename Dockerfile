# Stage 1: deps - Install dependencies
FROM oven/bun:1.2-debian AS deps
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
COPY packages/api/package.json packages/api/
COPY apps/server/package.json apps/server/
RUN mkdir -p apps/ui && echo '{"name":"@procella/ui","private":true}' > apps/ui/package.json
RUN bun install

# Stage 2: build - Compile the server
FROM deps AS build
ARG TARGETARCH
COPY tsconfig.json biome.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/
RUN bun build apps/server/src/index.ts \
      --compile \
      --target=bun-linux-$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x64") \
      --sourcemap \
      --compile-exec-argv="--smol" \
      --no-compile-autoload-dotenv \
      --no-compile-autoload-bunfig \
      --outfile=/procella

# Stage 3: runtime - Distroless nonroot (glibc required by bun compiled binaries)
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=build --chown=nonroot:nonroot /procella /procella
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/procella", "--healthz"]
ENTRYPOINT ["/procella"]
