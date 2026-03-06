---
title: Architecture Overview
description: High-level architecture, package structure, and design principles.
---

## System Architecture

Strata is a single Go binary that serves both the Pulumi Service API and an embedded React SPA. All persistent state lives in PostgreSQL, with blob storage (checkpoints) on the local filesystem or S3.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Pulumi CLI  │     │  Pulumi CLI  │     │   Web UI    │
└──────┬───────┘     └──────┬───────┘     └──────┬──────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────▼───────┐
                    │     Caddy     │  (optional, for multi-replica)
                    │  Round-Robin  │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
       ┌──────▼──┐   ┌──────▼──┐   ┌──────▼──┐
       │ Strata  │   │ Strata  │   │ Strata  │
       │  :8080  │   │  :8080  │   │  :8080  │
       └────┬────┘   └────┬────┘   └────┬────┘
            │              │              │
            └──────────────┼──────────────┘
                           │
              ┌────────────┼────────────┐
              │                         │
       ┌──────▼──────┐          ┌───────▼──────┐
       │ PostgreSQL  │          │  S3 / MinIO  │
       │   (state)   │          │   (blobs)    │
       └─────────────┘          └──────────────┘
```

## Request Flow

1. **Pulumi CLI** sends HTTP requests with `Accept: application/vnd.pulumi+8` and `Authorization: token <key>`
2. **Middleware chain** processes the request: RequestID → Logging → Recovery → Gzip → CORS → PulumiAccept → Auth → OrgAuth
3. **Handler** executes the business logic using injected service interfaces
4. **Service** interacts with PostgreSQL (metadata) and blob storage (checkpoints)
5. **Response** returns JSON with appropriate status codes

For update execution-phase requests (checkpoints, events), the auth flow differs:
- Uses `Authorization: update-token <lease-token>` instead of API token
- Validated by the `UpdateAuth` middleware against the lease token stored in the database

## Package Structure

```
cmd/strata/main.go              # Entrypoint, DI wiring, route registration
internal/
  app/                           # Application lifecycle (Start/Stop)
  auth/                          # Authenticator interface + implementations
    service.go                   #   Roles, Caller, DevAuthenticator
    descope.go                   #   DescopeAuthenticator (access keys)
  config/                        # Environment variable loading + validation
  crypto/                        # Encryption service
    service.go                   #   Service interface
    aes.go                       #   AES-256-GCM + HKDF implementation
    nop.go                       #   NopService stub
  db/                            # Database connection + migrations
    connect.go                   #   pgxpool setup
    migrate.go                   #   Embedded SQL migration runner
    migrations/                  #   SQL migration files
  http/
    server.go                    # HTTP server lifecycle
    encode/                      # JSON response helpers
    handlers/                    # HTTP handlers
    middleware/                  # Auth, CORS, Gzip, Logging, etc.
    spa/                         # SPA handler (serves embedded React app)
  stacks/                        # Stack CRUD service
    service.go                   #   Service interface
    postgres.go                  #   PostgreSQL implementation
  updates/                       # Update lifecycle service
    service.go                   #   Service interface (18 methods)
    postgres.go                  #   PostgreSQL impl + TTL caches
    gc_worker.go                 #   Orphan garbage collection
  checkpoints/                   # Checkpoint storage service
  events/                        # Event ingestion service
  storage/blobs/                 # Blob storage abstraction
    interface.go                 #   BlobStore interface
    local.go                     #   Local filesystem implementation
    s3.go                        #   S3 implementation
web/                             # Embedded React SPA
  embed.go                       #   go:embed dist/*
  dist/                          #   Built assets
```

## Design Principles

### Accept Interfaces, Return Structs

Service interfaces are defined where they are **consumed**, not where they are implemented. Each handler receives an interface; the `main.go` wiring decides which concrete implementation to inject.

```go
// In handlers/ — defines what it needs
type stackService interface {
    GetStack(ctx context.Context, org, project, stack string) (*stacks.Stack, error)
    // ...
}

// In stacks/ — returns a concrete struct
func NewPostgresService(db *pgxpool.Pool) *PostgresService { ... }
```

### NopService Pattern

Unimplemented service phases use stub implementations that return sensible zero values. This allows the server to start and serve traffic even before all features are complete.

### Middleware Chain

All middleware is composable and applied in a defined order in `main.go`:

1. `RequestID` — adds `X-Request-ID` to every request
2. `Logging` — structured JSON request/response logging
3. `Recovery` — panic recovery with stack trace logging
4. `Gzip` — transparent response compression
5. `CORS` — cross-origin headers
6. `PulumiAccept` — enforces `Accept: application/vnd.pulumi+8` on `/api/` routes
7. `Auth` — validates API token, sets `Caller` in context
8. `OrgAuth` — checks org membership + role against HTTP method

### All State in PostgreSQL

No in-memory state that can't be lost. Caches (stack ID, lease token) are purely performance optimizations with short TTLs — the database is always the source of truth. This makes horizontal scaling trivial.
