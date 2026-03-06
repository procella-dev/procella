---
title: Horizontal Scaling
description: Running multiple Strata replicas behind a load balancer.
---

Strata is designed to scale horizontally. The Go binary is stateless — all shared state lives in PostgreSQL and S3-compatible blob storage. You can run N replicas behind a load balancer with no code changes.

## Architecture

```
┌──────────┐
│ Pulumi   │
│ CLI      │
└────┬─────┘
     │
┌────▼─────┐
│  Caddy   │  round-robin LB + health checks
│  :8080   │
└────┬─────┘
     │
  ┌──┼──┐
  │  │  │
┌─▼┐┌▼─┐┌▼─┐
│R1││R2││R3│  Strata replicas (stateless)
└─┬┘└┬─┘└┬─┘
  │  │   │
  └──┼───┘
     │
┌────▼─────┐   ┌─────────┐
│PostgreSQL │   │ S3/MinIO│
│  (state)  │   │ (blobs) │
└───────────┘   └─────────┘
```

## Quick Start

```bash
make cluster          # Start 3 replicas + Caddy + PostgreSQL + MinIO
make e2e-cluster      # Run full E2E tests against the cluster
make cluster-down     # Tear down
```

## What's Shared

| Component | Storage | Scaling Impact |
|---|---|---|
| Database metadata | PostgreSQL | Shared — all replicas connect to the same database |
| Checkpoints | S3 (MinIO) | Shared — all replicas read/write the same bucket |
| In-memory caches | Per-replica | Independent — each replica has its own cache |
| GC worker | One active | Advisory lock ensures only one runs at a time |

## Cache Safety

Strata uses two in-memory TTL caches for performance. Both are safe for multi-replica deployment:

### Stack ID Cache (5-minute TTL)

Maps `org/project/stack` → UUID. Stack IDs are **immutable once created** — a stack name always maps to the same UUID. The cache can never serve stale data.

### Lease Token Cache (30-second TTL)

Caches lease token validation results. The database is always the source of truth for writes:
- Cache hit → avoid a database round-trip for token validation
- Cache miss → query the database, populate cache
- Lease renewal/cancellation → writes go directly to the database; cached entries expire naturally within 30 seconds

The 30-second TTL means that in the worst case, a cancelled update's lease token could be accepted for up to 30 seconds on other replicas. This is acceptable because:
1. The CLI retries on conflict, so a briefly-valid stale token causes a retry, not corruption
2. The GC worker's 60-second cycle is much longer than the cache TTL

## Cluster-Safe GC

The garbage collection worker uses PostgreSQL advisory locks to ensure only one instance runs across the entire cluster:

```sql
SELECT pg_try_advisory_lock(0x5472617461_4743);  -- "StrataGC"
```

- Each replica attempts to acquire the lock every 60 seconds
- Only the replica that acquires the lock runs the GC cycle
- The lock is released after each cycle completes
- If the holding replica crashes, PostgreSQL automatically releases the lock when the connection closes

## Load Balancer Configuration

### Caddy (Included)

The included `Caddyfile` configures Caddy as a simple round-robin reverse proxy:

```
:8080 {
    reverse_proxy strata-cluster:8080 {
        lb_policy round_robin
        health_uri /healthz
        health_interval 5s
    }
}
```

### Other Load Balancers

Any HTTP load balancer works. Requirements:
- **Health check**: `GET /healthz` returns 200 when healthy
- **Sticky sessions**: Not required — all state is in the database
- **Protocol**: HTTP/1.1 (Pulumi CLI uses HTTP/1.1)
- **Timeouts**: Set upstream timeout to at least 300 seconds (large `pulumi up` operations can take minutes)

## Production Considerations

### PostgreSQL

- Use a managed PostgreSQL service (RDS, Cloud SQL, etc.) for high availability
- Enable connection pooling (PgBouncer) if running many replicas
- The `pgxpool` driver handles connection pooling within each replica

### S3 Storage

- Use real S3 or a managed S3-compatible service instead of MinIO
- Configure `STRATA_BLOB_S3_BUCKET` and optionally `STRATA_BLOB_S3_ENDPOINT`
- Ensure the bucket exists before starting the server

### Replica Count

- Start with 2–3 replicas for redundancy
- Add replicas based on request volume — each replica handles concurrent requests efficiently via Go's goroutine model
- The database is typically the bottleneck, not the Go server

### Container Orchestration

The Docker Compose cluster profile is a development tool. For production, use:
- **Kubernetes** — deploy as a `Deployment` with `replicas: N`, backed by a `Service`
- **ECS/Fargate** — define a task with the Strata container and a service with desired count
- **Docker Swarm** — use `deploy.replicas` (similar to the compose cluster profile)

All options work because the binary is stateless and health-checkable.
