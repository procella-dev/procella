---
title: Docker Compose
description: Three profiles for development, dependencies, and cluster deployment.
---

The `docker-compose.yml` uses [YAML anchors](https://yaml.org/spec/1.2.2/#anchor) and [Docker Compose profiles](https://docs.docker.com/compose/profiles/) to serve three deployment configurations from a single file.

## Profiles

### Default (no profile) — Dependencies Only

```bash
docker compose up -d
```

Starts only the shared infrastructure:
- **PostgreSQL 17** — database on port 5432
- **MinIO** — S3-compatible blob storage on ports 9000 (API) and 9001 (console)
- **MinIO Init** — one-shot container that creates the `strata-checkpoints` bucket

Use this when running the Strata server directly on your machine (e.g., via `go run`).

### Dev Profile — Full Stack

```bash
make dev
# or: docker compose --profile dev up --build
```

Starts the dependencies plus:
- **Strata** (Go) — Pulumi CLI API on port 8080
- **Strata Web** (Bun) — tRPC web dashboard API on port 3000
- **Caddy** — reverse proxy on port 8080 routing `/api/*` → Go, `/trpc/*` → Bun, `/*` → SPA

### Cluster Profile — Multi-Replica

```bash
make cluster
# or: docker compose --profile cluster up --build
```

Starts the dependencies plus:
- **3 Strata replicas** (`strata-cluster`) — using Docker Compose `deploy.replicas: 3`
- **Caddy** — reverse proxy on port 8080 with round-robin load balancing and health checks

## YAML Anchors

The compose file uses anchors to eliminate duplication between the `dev` and `cluster` services:

```yaml
# Anchor definition
x-strata: &strata
  build: .
  depends_on:
    postgres:
      condition: service_healthy
    minio:
      condition: service_healthy
    minio-init:
      condition: service_completed_successfully
  environment: &strata-env
    STRATA_LISTEN_ADDR: ":8080"
    STRATA_DATABASE_URL: "postgres://strata:strata@postgres:5432/strata?sslmode=disable"
    # ... all env vars
  healthcheck: &strata-health
    test: ["CMD", "/strata", "healthcheck"]
    interval: 5s
    timeout: 3s
    retries: 10

# Dev service — single instance
strata:
  <<: *strata
  profiles: [dev]
  ports:
    - "8080:8080"

# Cluster service — 3 replicas (no port mapping, Caddy handles routing)
strata-cluster:
  <<: *strata
  profiles: [cluster]
  deploy:
    replicas: 3
```

Three anchor levels allow mixing and matching:
- `&strata` — full service definition (build, depends_on, environment, healthcheck)
- `&strata-env` — just the environment block (reusable independently)
- `&strata-health` — just the healthcheck block

## Caddy Configuration

Caddy routes requests to the appropriate service based on URL path:

```
:8080 {
    handle /api/* {
        reverse_proxy strata:8080     # Go — Pulumi CLI protocol
    }
    handle /trpc/* {
        reverse_proxy strata-web:3000 # Bun — tRPC web API
    }
    handle {
        # Static SPA fallback
    }
}
```

In the cluster profile, the Go service uses round-robin load balancing across 3 replicas with health checks. The Bun tRPC service runs as a single instance (stateless, can be scaled independently).

## Healthcheck

All Strata containers use the binary's built-in healthcheck subcommand:

```dockerfile
HEALTHCHECK CMD ["/strata", "healthcheck"]
```

The `strata healthcheck` command reads `STRATA_LISTEN_ADDR`, makes a `GET /healthz` request to localhost, and exits 0 (healthy) or 1 (unhealthy). This works with the `scratch` Docker image which has no shell or curl.

## Make Targets

| Target | Command | Description |
|---|---|---|
| `make dev` | `docker compose --profile dev up --build` | Start dev environment |
| `make cluster` | `docker compose --profile cluster up --build` | Start cluster environment |
| `make down` | `docker compose --profile dev down -v` | Stop dev + remove volumes |
| `make cluster-down` | `docker compose --profile cluster down -v` | Stop cluster + remove volumes |
| `make deps` | `docker compose up -d` | Start only dependencies |
| `make build` | `docker build -t strata:dev .` | Build Docker image locally |

## Volumes

Two named volumes persist data across container restarts:

| Volume | Container | Purpose |
|---|---|---|
| `postgres-data` | postgres | Database files |
| `minio-data` | minio | Blob storage files |

Both `make down` and `make cluster-down` use `-v` to remove volumes, ensuring a clean slate. Remove the `-v` flag if you want data to persist between restarts.
