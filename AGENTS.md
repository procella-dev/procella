# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Version-controlled: Built on Dolt with cell-level merge
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:

- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->

## Project Architecture

### Overview

Strata is a self-hosted Pulumi backend written in Go. It implements the Pulumi Service API so that `pulumi login`, `pulumi stack init`, `pulumi up`, etc. work against it.

### Tech Stack

- **Go 1.25.7** (via mise — ALL tool invocations must use `mise exec --`)
- **PostgreSQL 17** (metadata, state)
- **chi v5** (HTTP router)
- **pgx v5** (Postgres driver)
- **golangci-lint v2** (consolidated linting + formatting — gofumpt, goimports as formatters; gosec, govet, revive, etc. as linters)
- **Pulumi SDK v3.225.1** (apitype definitions)
- **React 19 + Vite 7 + TailwindCSS v4** (web UI in `web/`)

### Directory Structure

```
cmd/strata/main.go          # Server entrypoint, route registration, SPA mount
internal/
  app/app.go                 # App struct (Start/Stop lifecycle)
  auth/service.go            # Authenticator interface, DevAuthenticator
  config/config.go           # Config from env vars (STRATA_*)
  db/
    connect.go               # pgxpool connection
    migrate.go               # Embedded SQL migrations
    migrations/              # SQL files (0001_initial.up.sql, etc.)
  http/
    server.go                # HTTP server lifecycle
    encode/                  # WriteJSON, WriteError helpers
    handlers/                # HTTP handlers (stack, user, update, health, capabilities, crypto)
    middleware/               # Auth, CORS, Gzip, Logging, PulumiAccept, Recovery, RequestID
    spa/                     # SPA handler — serves embedded React app with index.html fallback
  stacks/
    service.go               # Service interface (7 methods)
    postgres.go              # PostgreSQL implementation
    errors.go                # Sentinel errors
  updates/                   # Update lifecycle (Phase 3) + State ops (Phase 4) + Resilience (Phase 5)
    service.go               # Service interface (18 methods incl. GetUpdateEvents)
    postgres.go              # PostgreSQL implementation
    nop.go                   # NopService stub
    errors.go                # Sentinel errors
    gc_worker.go             # Orphan GC with pg advisory locks for cluster-safety
    delta.go                 # Delta checkpoint apply logic
  checkpoints/               # Checkpoint storage (Phase 3)
  events/                    # Event ingestion (Phase 3)
  crypto/                    # Encrypt/decrypt (Phase 4)
    service.go               # Service interface (Encrypt/Decrypt with stackFQN)
    nop.go                   # NopService stub
    aes.go                   # AES-256-GCM with HKDF per-stack key derivation
    aes_test.go              # 6 unit tests
  storage/blobs/             # Blob storage (local + S3)
web/                         # React SPA (Vite + React 19 + TailwindCSS v4)
  embed.go                   # go:embed dist/* for Go binary embedding
  dist/                      # Built assets (committed for go:embed)
  src/                       # React source (api client, pages, components)
e2e/                         # E2E acceptance tests (build tag: e2e)
.github/workflows/ci.yml    # CI: check + e2e jobs
```

### Key Patterns

- **Accept interfaces, return structs** — service interfaces defined where used
- **NopService pattern** — stub implementations for unimplemented phases
- **PulumiAccept middleware** — ALL `/api/` requests require `Accept: application/vnd.pulumi+8`
- **DevAuthenticator** — `Authorization: token <STRATA_DEV_AUTH_TOKEN>` for dev mode
- **Transactions** — CreateStack, RenameStack use pgx transactions
- **Auto-create** — CreateStack auto-creates org + project via INSERT ON CONFLICT DO NOTHING

### Pulumi Update Lifecycle Protocol (Phase 3)

The sequence the CLI follows during `pulumi up`:

1. **CreateUpdate**: `POST /api/stacks/{org}/{project}/{stack}/{kind}` (kind = update|preview|refresh|destroy)
   - Auth: `Authorization: token <api-token>`
   - Req: `apitype.UpdateProgramRequest` → Resp: `apitype.UpdateProgramResponse` (contains `updateID`)
2. **StartUpdate**: `POST /api/stacks/{org}/{project}/{stack}/update/{updateID}`
   - Auth: `Authorization: token <api-token>`
   - Req: `apitype.StartUpdateRequest` → Resp: `apitype.StartUpdateResponse` (contains lease `token`, `version`, `tokenExpiration`)
3. **Execution** (all use `Authorization: update-token <lease-token>`):
   - `PATCH .../checkpoint` — `PatchUpdateCheckpointRequest` (standard)
   - `PATCH .../checkpointverbatim` — `PatchUpdateVerbatimCheckpointRequest` (preserves JSON)
   - `POST .../events/batch` — `EngineEventBatch`
   - `POST .../renew_lease` — `RenewUpdateLeaseRequest` → `RenewUpdateLeaseResponse`
4. **CompleteUpdate**: `POST .../complete` — `CompleteUpdateRequest` {status: succeeded|failed|cancelled}

### State Operations Protocol (Phase 4)

**Export**: `GET /api/stacks/{org}/{project}/{stack}/export` returns latest checkpoint as `apitype.UntypedDeployment`.
- `GET .../export/{version}` returns specific version checkpoint.
- Empty stacks return valid `UntypedDeployment` with `version: 3` and non-null deployment JSON.

**Import**: `POST /api/stacks/{org}/{project}/{stack}/import` — body is `apitype.UntypedDeployment`, response is `apitype.ImportStackResponse{UpdateID}`.
- Single-shot operation (no create→start→complete lifecycle).
- CLI polls `GET .../update/{updateID}` after import; return `UpdateResults{Status: "succeeded"}`.
- Cross-stack import requires `--force` flag from CLI.

**Encrypt/Decrypt**: `POST .../encrypt` takes `apitype.EncryptValueRequest{Plaintext []byte}`, returns `EncryptValueResponse{Ciphertext []byte}`.
- `POST .../decrypt` takes `DecryptValueRequest{Ciphertext []byte}`, returns `DecryptValueResponse{Plaintext []byte}`.
- `Plaintext`/`Ciphertext` are `[]byte` → JSON-encoded as base64.
- Uses AES-256-GCM with HKDF per-stack key derivation from a master key.
- Dev mode auto-generates deterministic key from `sha256("strata-dev-encryption-key")`.

### Resilience Protocol (Phase 5)

**Cancel Update**: `POST /api/stacks/{org}/{project}/{stack}/update/{updateID}/cancel`
- Uses regular API token auth (NOT update-token). No request body, no response body.
- Transaction: set status='cancelled', clear lease token, clear stack's active update lock.
- Idempotent: canceling an already-canceled update returns success.

**Orphan GC Worker**: Background goroutine that cleans up stale updates.
- Scans for: running updates with expired leases, stale not-started/requested updates (>1hr).
- Uses `pg_try_advisory_lock(0x5472617461_4743)` for cluster-safe execution — only one instance runs GC at a time.
- Runs reconciliation at startup, then every 60s. Lock acquired per-cycle, released after each cycle.
- Wired in `main.go`: `Start()` after server, `Stop()` before shutdown.

### Cluster-Safety

All state lives in PostgreSQL. No in-memory caches, no local-only state.
- **Transactions** protect critical sections (create stack, rename, cancel update).
- **Unique index** prevents multiple active updates per stack.
- **pg advisory locks** ensure only one GC worker runs across the cluster.
- **Local blob storage** is the only non-clusterable component — use S3 (`STRATA_BLOB_BACKEND=s3`) for multi-node.

### Quality Gates

```bash
make check      # lint → vuln → build → test (unit only)
make e2e         # E2E tests (requires postgres + pulumi CLI)
make check-all   # check + e2e
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| STRATA_LISTEN_ADDR | :8080 | Server listen address |
| STRATA_DATABASE_URL | (required) | PostgreSQL connection string |
| STRATA_AUTH_MODE | dev | Auth mode (dev or descope) |
| STRATA_DEV_AUTH_TOKEN | (required in dev) | Dev auth token |
| STRATA_DEV_USER_LOGIN | dev-user | Dev user login name |
| STRATA_DEV_ORG_LOGIN | dev-org | Dev org login name |
| STRATA_BLOB_BACKEND | local | Blob storage (local or s3) |
| STRATA_BLOB_LOCAL_PATH | ./data/blobs | Local blob path |
| STRATA_ENCRYPTION_KEY | (auto in dev) | 64 hex chars (32 bytes) for AES-256 encryption |
