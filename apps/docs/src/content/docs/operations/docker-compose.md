---
title: Docker Compose
description: Development and cluster deployment profiles.
---

The `docker-compose.yml` uses [Docker Compose profiles](https://docs.docker.com/compose/profiles/) to serve multiple deployment configurations from a single file.

## Required secrets

Every profile interpolates two secrets from your environment (or `.env`) and refuses to start without them:

```bash
export PROCELLA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export PROCELLA_TICKET_SIGNING_KEY="$(openssl rand -hex 32)"
```

## Profiles

### Default (no profile) — Dependencies Only

```bash
docker compose up -d
```

Starts only the shared infrastructure:
- **PostgreSQL 18**: database on port 5432, persisting to the `postgres-data` volume mounted at `/var/lib/postgresql` (postgres:18 keeps `PGDATA` at `/var/lib/postgresql/18/docker`)
- **MinIO**: S3-compatible blob storage on ports 9000 (API) and 9001 (console), root credentials `minioadmin` / `minioadmin`, which are the same credentials the server sends as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- **MinIO Init** — one-shot container that creates the `procella-checkpoints` bucket

Use this when running the Procella server directly on your machine (e.g., via `bun run dev`).

### Dev Profile — Single Server

```bash
docker compose --profile dev up --build
```

Starts the dependencies plus:
- **Migrate** — one-shot container that runs database migrations via `drizzle-kit`
- **Procella** — single server instance on port 9090

### Cluster Profile — Multi-Replica

```bash
bun run docker:cluster
# or: docker compose --profile cluster up --build
```

Starts the dependencies plus:
- **Migrate** — one-shot container that runs database migrations via `drizzle-kit`
- **3 Procella replicas** — using Docker Compose `deploy.replicas: 3`
- **Procella UI** — Caddy serving the React SPA on port 80
- **Caddy** — reverse proxy on port 9090, routing `/api/*` and `/trpc/*` to server replicas and `/*` to the UI

## Caddy Configuration

The `caddy` service mounts the repo-root `Caddyfile` read-only. It routes by path:

```
:9090 {
    handle /api/* {
        reverse_proxy procella-cluster:9090
    }
    handle /trpc/* {
        reverse_proxy procella-cluster:9090
    }
    handle /healthz {
        reverse_proxy procella-cluster:9090
    }
    @server_root_routes path /github/setup
    handle @server_root_routes {
        reverse_proxy procella-cluster:9090
    }
    handle {
        reverse_proxy procella-ui:80
    }
}
```

`/api/*` (Pulumi CLI protocol), `/trpc/*` (dashboard API), `/healthz`, and `/github/setup` (GitHub App callback) route to the Procella server replicas. `/cron/gc` stays private because the Compose server runs its own GC worker. All other paths route to the UI container, which serves the React SPA with client-side routing fallback.

## Healthcheck

All Procella containers expose a health endpoint that checks the database connection **and** that the schema has been migrated:

```
GET /healthz → 200 OK        (server reachable, schema migrated)
GET /healthz → 503           (database unreachable, or schema not migrated)
```

A database that answers queries but has no Procella tables reports 503, so an unmigrated deployment never advertises itself as ready.

Docker Compose uses the built-in `--healthz` flag to check health:

```yaml
healthcheck:
  test: ["CMD", "/procella", "--healthz"]
  interval: 5s
  timeout: 3s
  retries: 10
```

## Database Migrations

Migrations run automatically via a one-shot `migrate` container that executes `drizzle-kit migrate` before the server starts. Both the dev and cluster profiles depend on the migrate container completing successfully.

## Upgrading the PostgreSQL 18 volume

Earlier compose revisions mounted the named volume at `/var/lib/postgresql/data`, but the PostgreSQL 18 image stores its cluster under `/var/lib/postgresql/18/docker`. Before the first update to this revision, export the running database:

```bash
docker compose exec -T postgres pg_dumpall -U procella > procella-postgres-backup.sql
```

After updating and starting PostgreSQL with the corrected mount, restore that backup:

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U procella < procella-postgres-backup.sql
```

Do not remove the old container or anonymous volume until the restored database has been verified.

## Bun Scripts

| Script | Command | Description |
|---|---|---|
| `bun run dev` | Starts deps + Bun server + Vite UI | Full dev environment |
| `bun run dev:down` | `docker compose down -v` | Stop dev + remove volumes |
| `bun run docker:build` | `docker build -t procella:dev .` | Build Docker image |
| `bun run docker:cluster` | `docker compose --profile cluster up --build` | Start cluster |

## Volumes

Two named volumes persist data across container restarts:

| Volume | Container | Purpose |
|---|---|---|
| `postgres-data` | postgres | Database files |
| `minio-data` | minio | Blob storage files |

Use `bun run dev:down` to stop containers and remove volumes for a clean slate.
