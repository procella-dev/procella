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

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
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

Procella is a self-hosted Pulumi backend written in TypeScript, running on Bun. It implements the Pulumi Service API so that `pulumi login`, `pulumi stack init`, `pulumi up`, etc. work against it. A tRPC web API serves a React dashboard for viewing stacks, updates, and events.

### Tech Stack

- **Bun 1.2** (runtime + package manager + test runner + bundler)
- **PostgreSQL 17** (metadata, state)
- **Hono v4** (HTTP router for Pulumi CLI protocol)
- **tRPC v11** (web dashboard API, mounted on same server)
- **Drizzle ORM** (type-safe PostgreSQL queries via `Bun.sql`)
- **React 19 + Vite 7 + TailwindCSS v4** (web dashboard SPA)
- **Biome** (strict linter + formatter for TypeScript)
- **Caddy 2** (reverse proxy for production/cluster)

### Directory Structure

```
packages/
  types/               # Pulumi protocol types (generated via tygo) + domain types + errors
  config/              # Zod-validated env config (PROCELLA_*)
  db/                  # Drizzle schema, connection factory (Bun.sql driver)
  crypto/              # AES-256-GCM with HKDF per-stack key derivation
  storage/             # Blob storage (local filesystem + S3)
  auth/                # Authenticator: dev mode (static token) + Descope (JWT)
  stacks/              # Stack service: CRUD, rename, tags (PostgreSQL)
  updates/             # Update lifecycle, checkpoints, events, GC worker (PostgreSQL + blob)
  api/                 # @procella/api — tRPC router definition (stacks.list, updates.list/latest, events.list)
apps/
  server/              # @procella/server — Hono HTTP server (CLI routes + tRPC mount + middleware)
  ui/                  # @procella/ui — React SPA (Vite + Tailwind + tRPC client)
  docs/                # @procella/docs — Starlight documentation site
examples/              # Pulumi YAML example programs (7 examples, used by E2E tests)
e2e/                   # E2E acceptance tests (89 tests across 9 files)
Dockerfile             # bun build --compile → debian-slim
docker-compose.yml     # postgres + minio (dev), + procella replicas + caddy (cluster)
Caddyfile              # Reverse proxy: /api/* + /trpc/* → server, /* → UI
```

### Key Patterns

- **Single process** — CLI API + tRPC dashboard API share one Hono server on port 9090
- **PulumiAccept middleware** — `/api/*` routes require `Accept: application/vnd.pulumi+8`; `/trpc/*` routes bypass this
- **Dual auth on tRPC** — Same `AuthService.authenticate()` as CLI routes, using `Authorization: token <value>`
- **DevAuthenticator** — `Authorization: token <PROCELLA_DEV_AUTH_TOKEN>` for dev mode
- **Transactions** — CreateStack, RenameStack, CancelUpdate use Drizzle transactions
- **Auto-create** — CreateStack auto-creates org + project via INSERT ON CONFLICT DO NOTHING
- **Workspace packages** — Domain logic in `packages/*`, app assembly in `apps/*`

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
- Dev mode auto-generates deterministic key from `sha256("procella-dev-encryption-key")`.

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
- **Local blob storage** is the only non-clusterable component — use S3 (`PROCELLA_BLOB_BACKEND=s3`) for multi-node.
- **Railway runs 3 replicas** — any in-process state (Maps, caches, etc.) is NOT shared across instances. If you need something shared, it goes in PostgreSQL.

### Auth

- **Descope** is the auth provider in production. Session JWTs are issued as the `DS` httpOnly cookie by the Descope React SDK.
- **`authenticate(request)`** in `packages/auth/src/index.ts` reads `Authorization: Bearer <jwt>` or `Authorization: token <key>`.
- **Descope's `DS` cookie lives on `api.descope.com`**, NOT on our domain — browsers will NOT send it to our server. Do not rely on the cookie for our API auth.
- **`EventSource` cannot set custom headers.** For tRPC subscriptions (SSE), use `httpSubscriptionLink` with `connectionParams` — tRPC serializes these as URL query params and the server reads them in `createContext` via `opts.info.connectionParams`. See `apps/server/src/routes/index.ts`.
- **NEVER invent a separate auth mechanism** (tickets, Postgres tables, custom query-token middleware) — use tRPC `connectionParams` for subscription auth and the standard `Authorization` header for all other requests.
- **`sessionTokenViaCookie` mode**: If the Descope project is configured to store sessions in cookies (`sessionTokenViaCookie: true` on `AuthProvider`), the `DS` cookie IS set on our domain and browsers send it automatically. BUT in that mode `getSessionToken()` returns `null` — the JWT is not accessible to JS. We currently do NOT use this mode (`AuthProvider` has no `sessionTokenViaCookie`), so `getSessionToken()` works and tRPC `connectionParams` is the correct subscription auth pattern.
- **Dev mode** uses `Authorization: token <PROCELLA_DEV_AUTH_TOKEN>`. The cookie fallback is Descope-only.
- **CLI** uses `Authorization: token <access-key>` (long-lived Descope access key, NOT a session JWT).

### Cluster-Safety Checklist

Before adding ANY new stateful thing, ask: "what happens when this runs on 3 replicas simultaneously?"
- In-process Maps, caches, counters → NOT safe. Put it in PostgreSQL.
- Background timers/workers → use `pg_try_advisory_lock` so only one replica runs it.
- The `pg advisory lock` pattern is already used by `GCWorker` — follow that.

### Pulumi API Path Is Sacred

`/api/*` routes are the Pulumi Service API. Custom endpoints MUST NOT go there.
- All dashboard/UI-only features go through tRPC (`/trpc/*`)
- The only exceptions are the CLI protocol routes defined in `PulumiRoutes`
- Adding custom REST endpoints to `/api/*` breaks the Pulumi CLI

### Vite Dev Server Proxy

`apps/ui/vite.config.ts` proxies `/trpc`, `/api`, `/healthz` to the backend.
- Default port: `9090` (production/dev)
- Override with `VITE_API_PORT` env var for tests (e.g. Playwright uses `18080`)
- Playwright tests MUST set `VITE_API_PORT` to match `PLAYWRIGHT_API_URL` port

### Playwright Tests Use Node, Not Bun

Playwright runs in Node.js context — NOT Bun. This means:
- `Bun.spawn`, `Bun.write`, `Bun.sleep`, `SQL from bun` are NOT available in test files or `global-setup.ts`
- Use `node:child_process.spawn`, `node:fs/promises.writeFile`, `setTimeout` instead
- Use `pg` npm package for direct DB access (not `bun:sql`)
- `import.meta.dirname` may not work — use `__dirname` in CommonJS context
- Keep a separate `tsconfig.playwright.json` with `"module": "CommonJS"` for Playwright files

### Mocks Must Be Updated With Interfaces

When a new method is added to an interface (e.g. `StacksService`, `UpdatesService`), ALL test mock objects implementing that interface must be updated too. CI catches this via `tsc --build` (project references) even when local typecheck passes.

### Quality Gates

```bash
bun run check      # biome lint → typecheck → bun test (320 unit tests)
bun run e2e        # E2E acceptance tests (89 tests, requires postgres + pulumi CLI)
bun run check:all  # check + e2e
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| PROCELLA_LISTEN_ADDR | :9090 | Server listen address |
| PROCELLA_DATABASE_URL | (required) | PostgreSQL connection string |
| PROCELLA_AUTH_MODE | dev | Auth mode (dev or descope) |
| PROCELLA_DEV_AUTH_TOKEN | (required in dev) | Dev auth token |
| PROCELLA_DEV_USER_LOGIN | dev-user | Dev user login name |
| PROCELLA_DEV_ORG_LOGIN | dev-org | Dev org login name |
| PROCELLA_BLOB_BACKEND | local | Blob storage (local or s3) |
| PROCELLA_BLOB_LOCAL_PATH | ./data/blobs | Local blob path |
| PROCELLA_ENCRYPTION_KEY | (auto in dev) | 64 hex chars (32 bytes) for AES-256 encryption |

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any shell command containing `curl` or `wget` will be intercepted and blocked by the context-mode plugin. Do NOT retry.
Instead use:
- `mcp__context-mode__ctx_fetch_and_index(url, source)` to fetch and index web pages
- `mcp__context-mode__ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any shell command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` will be intercepted and blocked. Do NOT retry with shell.
Instead use:
- `mcp__context-mode__ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### Direct web fetching — BLOCKED
Do NOT use any direct URL fetching tool. Use the sandbox equivalent.
Instead use:
- `mcp__context-mode__ctx_fetch_and_index(url, source)` then `mcp__context-mode__ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Shell (>20 lines output)
Shell is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `mcp__context-mode__ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `mcp__context-mode__ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### File reading (for analysis)
If you are reading a file to **edit** it → reading is correct (edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `mcp__context-mode__ctx_execute_file(path, language, code)` instead. Only your printed summary enters context.

### grep / search (large results)
Search results can flood context. Use `mcp__context-mode__ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `mcp__context-mode__ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `mcp__context-mode__ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `mcp__context-mode__ctx_execute(language, code)` | `mcp__context-mode__ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `mcp__context-mode__ctx_fetch_and_index(url, source)` then `mcp__context-mode__ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `mcp__context-mode__ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `upgrade` MCP tool, run the returned shell command, display as checklist |
