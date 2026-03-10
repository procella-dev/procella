---
title: Architecture Overview
description: High-level architecture, package structure, and design principles.
---

## System Architecture

Procella runs as a single Bun process that serves both the Pulumi CLI API and the web dashboard API. Caddy acts as a reverse proxy in production, routing requests and load-balancing across replicas.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Pulumi CLI  │     │  Pulumi CLI  │     │   Browser   │
└──────┬───────┘     └──────┬───────┘     └──────┬──────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────▼───────┐
                    │     Caddy     │
                    │  (optional)   │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │  Procella       │
                    │  Bun :9090    │
                    │               │
                    │  /api/*       │  ← Pulumi CLI protocol (Hono)
                    │  /trpc/*      │  ← Dashboard API (tRPC)
                    │  /*           │  ← Static SPA (React)
                    └───┬───────┬───┘
                        │       │
           ┌────────────┘       └────────────┐
           │                                 │
     ┌─────▼───────┐                   ┌─────▼────────┐
     │ PostgreSQL  │                   │  S3 / MinIO  │
     │  (metadata) │                   │   (blobs)    │
     └─────────────┘                   └──────────────┘
```

### Single Process

| Route | Handler | Purpose |
|---|---|---|
| `/api/*` | Hono routes | Pulumi CLI protocol (stacks, updates, checkpoints, encryption) |
| `/trpc/*` | tRPC router | Web dashboard API (stacks.list, updates.list, events.list) |
| `/healthz` | Hono route | Health check endpoint |
| `/*` | Static files | React SPA (served in production) |

The Pulumi CLI API and tRPC dashboard share the same Hono server, database connection, and auth layer. Both use `Authorization: token <key>` for authentication.

## Request Flow

1. **Pulumi CLI** sends HTTP requests with `Accept: application/vnd.pulumi+8` and `Authorization: token <key>`
2. **Middleware chain** processes the request: CORS → PulumiAccept → Auth → RBAC
3. **Handler** executes the business logic using injected service interfaces
4. **Service** interacts with PostgreSQL (metadata) and blob storage (checkpoints)
5. **Response** returns JSON with appropriate status codes

For update execution-phase requests (checkpoints, events), the auth flow differs:
- Uses `Authorization: update-token <lease-token>` instead of API token
- Validated by the update-token middleware against the lease token stored in the database

## Package Structure

```
packages/
  types/                           # Pulumi protocol types + domain types + errors
    src/
      apitype.ts                   #   Pulumi wire types (generated via tygo)
      domain.ts                    #   Caller, Role, internal types
      errors.ts                    #   Typed domain errors (NotFound, Conflict, etc.)
  config/                          # Zod-validated env config
    src/index.ts                   #   PROCELLA_* env var parsing + validation
  db/                              # Drizzle ORM schema + connection factory
    src/
      schema.ts                    #   Table definitions (projects, stacks, updates, checkpoints, events)
      index.ts                     #   Bun.sql connection + Drizzle client
  crypto/                          # Encryption service
    src/index.ts                   #   AesCryptoService (AES-256-GCM + HKDF), NopCryptoService
  storage/                         # Blob storage abstraction
    src/index.ts                   #   BlobStorage interface, LocalBlobStorage, S3BlobStorage
  auth/                            # Authentication + authorization
    src/index.ts                   #   DevAuthService, DescopeAuthService, requireRole()
  stacks/                          # Stack CRUD service
    src/index.ts                   #   StacksService interface + PostgresStacksService
  updates/                         # Update lifecycle service
    src/
      types.ts                     #   UpdatesService interface
      postgres.ts                  #   PostgresUpdatesService implementation
      gc.ts                        #   Orphan garbage collection worker

  api/                             # @procella/api — tRPC router definition
    src/
      trpc.ts                      #   tRPC init + TRPCContext type
      router/index.ts              #   Root AppRouter
      router/stacks.ts             #   stacks.list
      router/updates.ts            #   updates.list, updates.latest
      router/events.ts             #   events.list

apps/
  server/                          # @procella/server — Hono HTTP server
    src/
      index.ts                     #   Server bootstrap, DI wiring
      routes/index.ts              #   Route registration + tRPC mount
      middleware/auth.ts            #   Auth + RBAC middleware
      handlers/                    #   HTTP handlers for each API endpoint
  ui/                              # @procella/ui — React SPA
    src/
      main.tsx                     #   tRPC + React Query + Descope providers
      pages/                       #   StackList, StackDetail, UpdateDetail, Tokens, Settings, CliLogin
      components/                  #   Layout (header, nav, user menu), shared components
```

## Design Principles

### Service Interfaces

Each domain package exports a service interface alongside its implementation. Handlers depend on the interface; the server bootstrap wires the concrete implementation.

```typescript
// In packages/stacks/src/index.ts
export interface StacksService {
  getStack(tenantId: string, org: string, project: string, stack: string): Promise<Stack>;
  // ...
}

export class PostgresStacksService implements StacksService { ... }
```

### NopService Pattern

Unimplemented service phases use stub implementations that return sensible zero values. This allows the server to start and serve traffic even before all features are complete.

### Middleware Chain

All middleware is composable and applied in the Hono router:

1. `CORS` — cross-origin headers
2. `PulumiAccept` — enforces `Accept: application/vnd.pulumi+8` on `/api/` routes
3. `Auth` — validates API token, sets `Caller` in context
4. `RBAC` — checks role against HTTP method (GET→viewer, POST→member, DELETE→admin)

### All State in PostgreSQL

No in-memory state that can't be lost. The database is always the source of truth. This makes horizontal scaling trivial — add replicas behind a load balancer with zero coordination.
