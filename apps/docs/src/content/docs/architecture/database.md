---
title: Database Schema
description: PostgreSQL schema — tables, indexes, constraints, and relationships.
---

Procella uses PostgreSQL 17 for all metadata and state. The schema is managed through Drizzle ORM migrations that run automatically on server startup.

## Entity Relationship

```
projects ◄──── stacks ◄──── updates ◄──── update_events
                                │
                                │
                            checkpoints
```

## Tables

### projects

Namespace for stacks. Each project is identified by a tenant ID (from Descope JWT) and a name.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `tenantId` | `TEXT` | `NOT NULL` (from Descope JWT) |
| `name` | `TEXT` | `NOT NULL` |
| `description` | `TEXT` | |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `updatedAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (tenantId, name)` |

**Index**: `idx_projects_tenant_name` on `(tenantId, name)` — fast lookup by tenant and project name.

### stacks

The core entity. Each stack belongs to a project and tracks its current active update.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `projectId` | `UUID` | `FK → projects(id) ON DELETE CASCADE` |
| `name` | `TEXT` | `NOT NULL` |
| `tags` | `JSONB` | `NOT NULL DEFAULT '{}'` |
| `activeUpdateId` | `UUID` | Nullable — set when an update is running |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `updatedAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (projectId, name)` |

**Index**: `idx_stacks_project_name` on `(projectId, name)` — fast lookup by project and stack name.

### updates

Tracks every operation performed on a stack (update, preview, refresh, destroy, import, etc.).

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `stackId` | `UUID` | Soft reference (no FK) — identifies the stack |
| `kind` | `TEXT` | `NOT NULL` — update, preview, refresh, destroy, import, etc. |
| `status` | `TEXT` | `NOT NULL DEFAULT 'not started'` — not started, requested, running, succeeded, failed, cancelled |
| `result` | `TEXT` | Nullable — final result message |
| `message` | `TEXT` | Nullable — status message |
| `version` | `INT` | `NOT NULL DEFAULT 1` — checkpoint version |
| `leaseToken` | `TEXT` | Nullable — token for execution phase |
| `leaseExpiresAt` | `TIMESTAMP` | Nullable — lease expiration time |
| `startedAt` | `TIMESTAMP` | Nullable |
| `completedAt` | `TIMESTAMP` | Nullable |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `updatedAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| `config` | `JSONB` | `NOT NULL DEFAULT '{}'` — stack config |
| `program` | `JSONB` | `NOT NULL DEFAULT '{}'` — program metadata |

**Index**: `idx_updates_active` — **Partial unique** on `(stackId) WHERE status IN ('not started', 'requested', 'running')` — prevents concurrent updates on the same stack.

### checkpoints

Infrastructure state snapshots. Each checkpoint is associated with an update and a version number.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `updateId` | `UUID` | `FK → updates(id) ON DELETE CASCADE` |
| `stackId` | `UUID` | Soft reference — identifies the stack |
| `version` | `INT` | `NOT NULL` — checkpoint version |
| `data` | `JSONB` | `NOT NULL` — deployment state |
| `blobKey` | `TEXT` | Nullable — reference to blob storage |
| `isDelta` | `BOOLEAN` | `NOT NULL DEFAULT false` — whether this is a delta checkpoint |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |

**Index**: `idx_checkpoints_update_version` on `(updateId, version)` — fast lookup of checkpoints per update.

### update_events

Engine events emitted during an update (resource operations, diagnostics, outputs).

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `updateId` | `UUID` | `FK → updates(id) ON DELETE CASCADE` |
| `sequence` | `INT` | `NOT NULL` — event sequence number |
| `kind` | `TEXT` | `NOT NULL` — event type |
| `fields` | `JSONB` | `NOT NULL` — event data |
| `createdAt` | `TIMESTAMP` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (updateId, sequence)` |

**Index**: `idx_update_events_update_sequence` on `(updateId, sequence)` — ordered event retrieval.

## Key Indexes

| Index | Table | Purpose |
|---|---|---|
| `idx_projects_tenant_name` | `projects` | `(tenantId, name)` — fast lookup by tenant and project |
| `idx_stacks_project_name` | `stacks` | `(projectId, name)` — fast lookup by project and stack |
| `idx_updates_active` | `updates` | **Partial unique**: `(stackId) WHERE status IN ('not started', 'requested', 'running')` — prevents concurrent updates |
| `idx_checkpoints_update_version` | `checkpoints` | `(updateId, version)` — fast checkpoint lookup |
| `idx_update_events_update_sequence` | `update_events` | `(updateId, sequence)` — ordered event retrieval |

## Auto-Create Pattern

When creating a stack, Procella auto-creates the project if it doesn't exist using Drizzle's `INSERT ... ON CONFLICT DO NOTHING`:

```typescript
await db.insert(projects).values({
  id: projectId,
  tenantId,
  name: projectName,
}).onConflictDoNothing();
```

This simplifies the CLI workflow — `pulumi stack init` creates everything in one step.

## Advisory Locks

The GC worker uses PostgreSQL advisory locks for cluster-safe execution:

```typescript
const lockId = 0x5472617461_4743; // "ProcellaGC"
const acquired = await db.execute(
  sql`SELECT pg_try_advisory_lock(${lockId})`
);
// ... do GC work ...
await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`);
```

This ensures only one replica runs garbage collection at a time, even in a multi-instance deployment. The lock is acquired per-cycle and released after each cycle completes.

## Cascade Deletes

Foreign keys use `ON DELETE CASCADE`:

- Deleting a **project** cascades to stacks, updates, events, checkpoints
- Deleting a **stack** cascades to updates, events, checkpoints
- Deleting an **update** cascades to events, checkpoints

This means `pulumi stack rm` cleanly removes all associated data.

## Migrations

Migrations are managed by Drizzle Kit (`drizzle-kit`) and run automatically on server startup. The schema is defined in TypeScript in `packages/db/src/schema.ts` and migrations are generated and applied via Drizzle's migration system.
