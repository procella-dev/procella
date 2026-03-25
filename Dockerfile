# syntax=docker/dockerfile:1
FROM oven/bun:1.3.11 AS base
WORKDIR /usr/src/app


# Stage 1: deps — install workspace dependencies
FROM base AS deps
COPY package.json bun.lock ./
COPY --parents ./*/*/package.json ./
RUN bun install --frozen-lockfile

FROM base AS ui
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY packages/ packages/
COPY apps/ui/ apps/ui/
COPY tsconfig.json ./
RUN bun run --cwd apps/ui build

FROM base AS build
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY tsconfig.json ./
RUN bun build --compile \
    --production --sourcemap --bytecode \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    apps/server/src/index.ts --outfile procella

# Stage 3: runtime — distroless (no shell, no pkg manager, ~25 MB)
# cc-debian13 provides glibc + libgcc + ca-certificates which the
# dynamically-linked Bun binary requires. scratch is not viable.
FROM gcr.io/distroless/cc-debian13 AS runtime
COPY --from=build /usr/src/app/procella /procella
COPY --from=build /usr/src/app/packages/db/drizzle /migrations
COPY --from=ui /usr/src/app/apps/ui/dist /ui
EXPOSE 9090
ENTRYPOINT ["/procella"]
