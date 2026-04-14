---
title: Migration Tool (procella-migrate)
description: Automated bulk migration tool for moving Pulumi stacks to Procella with validation, dry-run support, and audit trails.
---

`procella-migrate` is a CLI tool that automates migrating Pulumi stacks from any backend to Procella. It wraps the Pulumi CLI's export/import commands with bulk automation, validation, progress tracking, and safety guardrails.

:::note[When do you need this tool?]
For migrating 1–3 stacks, the [manual migration guide](./migration/) and the Pulumi CLI are sufficient. This tool is designed for teams migrating **many stacks** — across multiple projects, environments, and backends — where scripting, validation, and audit trails matter.
:::

## Installation

```bash
# npm
npm install -g @procella/migrate

# or run directly
npx @procella/migrate
```

## Quick Start

```bash
# Discover stacks on your current backend
procella-migrate discover --source https://api.pulumi.com

# Dry-run migration (validates everything, changes nothing)
procella-migrate run \
  --source https://api.pulumi.com \
  --target https://procella.example.com \
  --dry-run

# Execute migration
procella-migrate run \
  --source https://api.pulumi.com \
  --target https://procella.example.com

# Validate after migration
procella-migrate validate \
  --source https://api.pulumi.com \
  --target https://procella.example.com
```

## Commands

### `discover`

Lists all stacks on the source backend that are eligible for migration.

```bash
procella-migrate discover \
  --source https://api.pulumi.com \
  --filter "myorg/myproject/*" \
  --format table
```

Output:

```
Stack                           Resources  Last Updated
myorg/myproject/dev             12         2026-04-10T14:30:00
myorg/myproject/staging         45         2026-04-12T09:15:00
myorg/myproject/production      89         2026-04-13T11:00:00

3 stacks found, 146 total resources
```

Options:

| Flag | Description |
|---|---|
| `--source <url>` | Source backend URL |
| `--filter <glob>` | Filter stacks by name pattern (supports `*` wildcards) |
| `--format <table\|json>` | Output format |
| `--exclude <glob>` | Exclude stacks matching pattern |

### `run`

Migrates stacks from source to target backend.

```bash
procella-migrate run \
  --source https://api.pulumi.com \
  --target https://procella.example.com \
  --filter "myorg/myproject/*" \
  --concurrency 3 \
  --dry-run
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--source <url>` | (required) | Source backend URL |
| `--target <url>` | (required) | Target Procella URL |
| `--filter <glob>` | `*` | Stack name filter |
| `--exclude <glob>` | | Exclude stacks matching pattern |
| `--concurrency <n>` | `1` | Parallel stack migrations |
| `--dry-run` | `false` | Validate and report without modifying target |
| `--continue-on-error` | `false` | Skip failed stacks and continue |
| `--output-dir <path>` | `./migration-exports` | Directory for exported state files |
| `--keep-exports` | `false` | Retain export files after successful migration |

### `validate`

Validates migrated stacks by comparing source and target state.

```bash
procella-migrate validate \
  --source https://api.pulumi.com \
  --target https://procella.example.com \
  --filter "myorg/myproject/*"
```

Checks:

- Resource count matches between source and target
- All resource URNs are present on both sides

### `preflight`

Runs pre-migration connectivity and authentication checks.

```bash
procella-migrate preflight \
  --source https://api.pulumi.com \
  --target https://procella.example.com
```

Checks:

- Pulumi CLI is installed and in PATH
- Source backend is reachable
- Target Procella instance is reachable
- Source authentication token is valid
- Target authentication token is valid

## Migration Lifecycle

The tool follows this sequence for each stack:

```
1. Export     → pulumi stack export --show-secrets --file <temp>
2. Validate   → Parse JSON, check resource count, verify no corruption
3. Create     → Stack creation on Procella via API (idempotent)
4. Import     → State import via Procella API (atomic, single-shot)
5. Verify     → Compare resource URNs + count between source and target
6. Report     → Log result to audit trail
7. Cleanup    → Delete temp export file (unless --keep-exports)
```

In `--dry-run` mode, steps 3–4 are skipped — the tool exports and validates without modifying the target.

## Audit Trail

Every migration run produces an audit log:

```json
{
  "runId": "mig_2026-04-13T14-30-00-000Z",
  "source": "https://api.pulumi.com",
  "target": "https://procella.example.com",
  "startedAt": "2026-04-13T14:30:00.000Z",
  "completedAt": "2026-04-13T14:35:22.000Z",
  "stacks": [
    {
      "fqn": "myorg/myproject/dev",
      "status": "succeeded",
      "sourceResourceCount": 12,
      "targetResourceCount": 12,
      "duration": 3200
    },
    {
      "fqn": "myorg/myproject/production",
      "status": "succeeded",
      "sourceResourceCount": 89,
      "targetResourceCount": 89,
      "duration": 8100
    }
  ],
  "summary": {
    "total": 2,
    "succeeded": 2,
    "failed": 0,
    "skipped": 0
  }
}
```

## Selective Migration: Stacks, Not Projects

A core design principle: **you migrate stacks, not projects**. The tool operates at the stack level because:

1. **Projects are just namespaces** — they're auto-created when the first stack is imported into Procella
2. **Stacks are independent** — each stack has its own state, secrets, and lifecycle
3. **Granular control** — migrate `dev` first, validate for a week, then migrate `staging`, then `production`
4. **Mixed backends** — different stacks in the same project can live on different backends simultaneously

Use `--filter` to target specific stacks:

```bash
# Migrate only dev stacks
procella-migrate run --filter "*/*/dev" ...

# Migrate one specific project
procella-migrate run --filter "myorg/payments/*" ...

# Migrate everything except production
procella-migrate run --exclude "*/*/production" ...
```

## Safety Guarantees

| Guarantee | How |
|---|---|
| **Source is never modified** | Export is read-only; the tool never writes to the source backend |
| **Atomic per-stack** | Each stack migrates completely or fails — no partial state |
| **Idempotent** | Re-running migration on an already-migrated stack overwrites cleanly |
| **Secrets handled safely** | `--show-secrets` is always used; export files are deleted after import (unless `--keep-exports`) |
| **Validation before completion** | Resource count + URN comparison ensures state integrity |
| **Audit trail** | Full JSON log of every action for compliance and debugging |
| **Dry-run first** | Always run `--dry-run` before real migration to catch issues |

## Authentication

**Source token** (for exporting from the original backend):

1. `--source-token` flag
2. `PROCELLA_MIGRATE_SOURCE_TOKEN` env var
3. `PULUMI_ACCESS_TOKEN` env var (common Pulumi convention)

**Target token** (for importing into Procella):

1. `--target-token` flag
2. `PROCELLA_MIGRATE_TARGET_TOKEN` env var

The target token has **no fallback** to `PULUMI_ACCESS_TOKEN` — this prevents accidentally sending your Pulumi Cloud credentials to Procella (or vice versa). You must explicitly provide a target token.

## Architecture

```
packages/migrate/src/
├── cli.ts          — CLI entry point (node:util parseArgs)
├── index.ts        — Public programmatic API
├── types.ts        — Type definitions (StackRef, AuditLog, options)
├── log.ts          — ANSI-colored CLI output (table, step, success/error)
├── pulumi.ts       — Pulumi CLI adapter (spawn with per-call env overrides)
├── procella.ts     — Procella HTTP API client + glob filtering
├── audit.ts        — JSON audit trail writer
├── discover.ts     — discover command
├── migrate.ts      — run command (core export→create→import→verify pipeline)
├── validate.ts     — validate command (URN-level comparison)
└── preflight.ts    — preflight command (connectivity + auth checks)
```

The tool wraps the Pulumi CLI for state export (ensuring compatibility with all source backends) and uses Procella's HTTP API directly for stack creation and import (faster, no CLI overhead).
