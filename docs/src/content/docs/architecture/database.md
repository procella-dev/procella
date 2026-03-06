---
title: Database Schema
description: PostgreSQL schema — tables, enums, indexes, constraints, and relationships.
---

Strata uses PostgreSQL 17 for all metadata and state. The schema is managed through embedded SQL migrations that run automatically on server startup.

## Entity Relationship

```
organizations ◄──── organization_members ────► users
     │                                           │
     │                                           │
  projects                                  api_tokens
     │
     │
  stacks ◄──── updates ◄──── update_events
                  │
                  │
              checkpoints
```

## Tables

### users

Stores user accounts. Each user is identified by a unique `github_login` (used as the display identifier across the system, regardless of auth mode).

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `github_login` | `TEXT` | `NOT NULL UNIQUE` |
| `display_name` | `TEXT` | |
| `email` | `TEXT` | |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

### organizations

Tenant boundaries. Each organization is an isolated namespace for projects and stacks.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `github_login` | `TEXT` | `NOT NULL UNIQUE` |
| `display_name` | `TEXT` | |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

### organization_members

Maps users to organizations with a role. Composite primary key ensures one membership per user per org.

| Column | Type | Constraints |
|---|---|---|
| `organization_id` | `UUID` | PK, `FK → organizations(id) ON DELETE CASCADE` |
| `user_id` | `UUID` | PK, `FK → users(id) ON DELETE CASCADE` |
| `role` | `TEXT` | `NOT NULL DEFAULT 'member'` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

### api_tokens

Hashed API tokens for authentication. Tokens are stored as hashes; only the prefix is kept in plaintext for identification.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `user_id` | `UUID` | `FK → users(id) ON DELETE CASCADE` |
| `token_hash` | `TEXT` | `NOT NULL UNIQUE` |
| `token_prefix` | `TEXT` | `NOT NULL` |
| `description` | `TEXT` | |
| `last_used_at` | `TIMESTAMPTZ` | |
| `expires_at` | `TIMESTAMPTZ` | |
| `revoked_at` | `TIMESTAMPTZ` | |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

### projects

Namespace: `{org}/{project}`. Each project belongs to one organization.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `organization_id` | `UUID` | `FK → organizations(id) ON DELETE CASCADE` |
| `name` | `TEXT` | `NOT NULL` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (organization_id, name)` |

### stacks

The core entity. Each stack has a fully qualified name (`org/project/stack`) and tracks its current active operation.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `project_id` | `UUID` | `FK → projects(id) ON DELETE CASCADE` |
| `name` | `TEXT` | `NOT NULL` |
| `fully_qualified_name` | `TEXT` | `NOT NULL UNIQUE` |
| `current_operation_id` | `UUID` | Nullable — set when an update is active |
| `tags` | `JSONB` | `NOT NULL DEFAULT '{}'` |
| `secrets_provider` | `TEXT` | |
| `last_checkpoint_version` | `BIGINT` | `NOT NULL DEFAULT 0` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (project_id, name)` |

### updates

Tracks every operation performed on a stack.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `stack_id` | `UUID` | `FK → stacks(id) ON DELETE CASCADE` |
| `kind` | `update_kind` | `NOT NULL` (enum) |
| `status` | `update_status` | `NOT NULL DEFAULT 'not started'` (enum) |
| `program_name` | `TEXT` | `NOT NULL DEFAULT ''` |
| `program_runtime` | `TEXT` | `NOT NULL DEFAULT ''` |
| `program_main` | `TEXT` | `NOT NULL DEFAULT ''` |
| `program_description` | `TEXT` | `NOT NULL DEFAULT ''` |
| `config` | `JSONB` | `NOT NULL DEFAULT '{}'` |
| `metadata` | `JSONB` | `NOT NULL DEFAULT '{}'` |
| `lease_token` | `TEXT` | Nullable |
| `lease_expires_at` | `TIMESTAMPTZ` | Nullable |
| `version` | `INT` | `NOT NULL DEFAULT 0` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `started_at` | `TIMESTAMPTZ` | Nullable |
| `completed_at` | `TIMESTAMPTZ` | Nullable |

### update_events

Engine events emitted during an update (resource operations, diagnostics, outputs).

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `update_id` | `UUID` | `FK → updates(id) ON DELETE CASCADE` |
| `sequence` | `INT` | `NOT NULL` |
| `timestamp` | `INT` | `NOT NULL` |
| `event_data` | `JSONB` | `NOT NULL` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (update_id, sequence)` |

### checkpoints

Infrastructure state snapshots. Each checkpoint is associated with an update and a version number.

| Column | Type | Constraints |
|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` |
| `stack_id` | `UUID` | `FK → stacks(id) ON DELETE CASCADE` |
| `update_id` | `UUID` | `FK → updates(id) ON DELETE CASCADE` |
| `version` | `INT` | `NOT NULL` |
| `sequence_number` | `INT` | `NOT NULL DEFAULT 0` |
| `deployment` | `JSONB` | Nullable |
| `is_invalid` | `BOOLEAN` | `NOT NULL DEFAULT false` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

## Enums

### update_kind

```sql
CREATE TYPE update_kind AS ENUM (
    'update', 'preview', 'refresh', 'destroy',
    'rename', 'import', 'resource-import'
);
```

### update_status

```sql
CREATE TYPE update_status AS ENUM (
    'not started', 'requested', 'running',
    'failed', 'succeeded', 'cancelled'
);
```

## Key Indexes

| Index | Table | Purpose |
|---|---|---|
| `idx_updates_active_per_stack` | `updates` | **Partial unique**: `(stack_id) WHERE status IN ('not started', 'requested', 'running')` — prevents concurrent updates |
| `idx_updates_stack` | `updates` | Fast lookup of updates per stack |
| `idx_stacks_fqn` | `stacks` | Fast lookup by fully qualified name |
| `idx_checkpoints_stack_version` | `checkpoints` | `(stack_id, version DESC)` — latest checkpoint lookup |
| `idx_checkpoints_update` | `checkpoints` | Checkpoints per update |
| `idx_checkpoints_update_seq` | `checkpoints` | **Partial unique**: `(update_id, sequence_number) WHERE sequence_number > 0` — verbatim checkpoint idempotency |
| `idx_update_events_update` | `update_events` | `(update_id, sequence)` — ordered event retrieval |
| `idx_api_tokens_user` | `api_tokens` | Tokens per user |
| `idx_projects_org` | `projects` | Projects per org |

## Auto-Create Pattern

When creating a stack, Strata auto-creates the organization and project if they don't exist:

```sql
INSERT INTO organizations (github_login) VALUES ($1)
ON CONFLICT (github_login) DO NOTHING;

INSERT INTO projects (organization_id, name) VALUES ($1, $2)
ON CONFLICT (organization_id, name) DO NOTHING;
```

This simplifies the CLI workflow — `pulumi stack init` creates everything in one step.

## Advisory Locks

The GC worker uses PostgreSQL advisory locks for cluster-safe execution:

```sql
SELECT pg_try_advisory_lock(0x5472617461_4743);  -- "StrataGC"
-- ... do GC work ...
SELECT pg_advisory_unlock(0x5472617461_4743);
```

This ensures only one replica runs garbage collection at a time, even in a multi-instance deployment. The lock is acquired per-cycle and released after each cycle completes.

## Cascade Deletes

All foreign keys use `ON DELETE CASCADE`:

- Deleting an **organization** cascades to members, projects, stacks, updates, events, checkpoints
- Deleting a **stack** cascades to updates, events, checkpoints
- Deleting an **update** cascades to events, checkpoints

This means `pulumi stack rm` cleanly removes all associated data.

## Migrations

Migrations are embedded in the Go binary and run automatically on startup:

| Migration | Purpose |
|---|---|
| `0001_initial.up.sql` | Users, organizations, members, tokens, projects, stacks |
| `0002_updates.up.sql` | Update/status enums, updates, events, checkpoints |
| `0003_idempotency.up.sql` | Checkpoint idempotency index for verbatim writes |
