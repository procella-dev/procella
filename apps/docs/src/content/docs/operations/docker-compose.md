---
title: Docker Compose
description: Development and cluster deployment profiles.
---

The `docker-compose.yml` uses [Docker Compose profiles](https://docs.docker.com/compose/profiles/) to serve multiple deployment configurations from a single file.

## Profiles

### Default (no profile) — Dependencies Only

```bash
docker compose up -d
```

Starts only the shared infrastructure:
- **PostgreSQL 17** — database on port 5432
- **MinIO** — S3-compatible blob storage on ports 9000 (API) and 9001 (console)
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

Caddy routes requests based on path:

```
:9090 {
    handle /api/* {
        reverse_proxy procella-cluster:9090
    }
    handle /trpc/* {
        reverse_proxy procella-cluster:9090
    }
    handle {
        reverse_proxy procella-ui:80
    }
}
```

`/api/*` (Pulumi CLI protocol) and `/trpc/*` (dashboard API) route to the Procella server replicas. All other paths route to the UI container, which serves the React SPA with client-side routing fallback.

## Healthcheck

All Procella containers expose a health endpoint that checks both the server and database connectivity:

```
GET /healthz → 200 OK (server + database healthy)
GET /healthz → 503 Service Unavailable (database unreachable)
```

Docker Compose uses `curl` to check health:

```yaml
healthcheck:
  test: ["CMD-SHELL", "curl -sf http://localhost:9090/healthz || exit 1"]
  interval: 5s
  timeout: 3s
  retries: 10
```

## Database Migrations

Migrations run automatically via a one-shot `migrate` container that executes `drizzle-kit migrate` before the server starts. Both the dev and cluster profiles depend on the migrate container completing successfully.

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
