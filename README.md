# Procella

A self-hosted [Pulumi](https://www.pulumi.com/) backend. Run `pulumi login`, `pulumi stack init`, `pulumi up`, and every other CLI command against your own infrastructure — no Pulumi Cloud account required.

## Features

- **Full Pulumi CLI compatibility** — login, stack management, updates, previews, refreshes, destroys, state import/export
- **Web dashboard** — React SPA with stack/update/event views, API token management, and admin settings
- **Admin settings panel** — invite users, manage roles, view audit log, edit tenant profile (Descope mode)
- **API token management** — create and revoke Descope access keys from the browser dashboard
- **Browser CLI login** — `pulumi login` opens a browser flow; token is stored automatically
- **Multi-tenant authentication** — dev mode with static tokens or [Descope](https://www.descope.com/) with tenant RBAC
- **Role-based access control** — viewer / member / admin roles enforced per-organization
- **AES-256-GCM encryption** — per-stack key derivation via HKDF for secrets at rest
- **Horizontal scaling** — stateless server behind Caddy load balancer, PostgreSQL for all shared state
- **S3-compatible blob storage** — local filesystem or any S3-compatible backend (AWS S3, MinIO, R2)
- **Single process** — CLI API + tRPC dashboard share one Hono server
- **Minimal Docker image** — `bun build --compile` → debian-slim

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun 1.2 |
| HTTP Router | Hono v4 |
| Dashboard API | tRPC v11 + Drizzle ORM |
| Dashboard UI | React 19, Vite 7, Tailwind CSS v4 |
| Database | PostgreSQL 17 |
| Auth | Descope / static tokens |
| Encryption | AES-256-GCM + HKDF |
| Blob Storage | Local filesystem / S3 |
| Reverse Proxy | Caddy 2 |
| Quality | Biome + TypeScript strict |

## Quick Start

```bash
# Clone and start the dev environment
git clone https://github.com/procella-dev/procella.git
cd procella
bun run dev
```

This starts PostgreSQL, MinIO, the Bun server (with hot-reload), and the Vite UI dev server locally.

```bash
# Dev mode — set token directly
export PULUMI_ACCESS_TOKEN=devtoken123
pulumi login http://localhost:9090

# Descope mode — browser login flow (PULUMI_CONSOLE_DOMAIN is set in mise.toml)
pulumi login http://localhost:9090
# The CLI opens your browser to /cli-login, you sign in via Descope,
# and the token is stored automatically in ~/.pulumi/credentials.json

# Create and deploy a stack
mkdir my-project && cd my-project
pulumi new typescript
pulumi up
```

## Running in Production

For horizontal scaling with multiple replicas behind a load balancer:

```bash
bun run docker:cluster   # 3 replicas + Caddy LB + PostgreSQL + MinIO
bun run e2e:cluster      # Run acceptance tests against the cluster
```

See the [Horizontal Scaling](apps/docs/src/content/docs/operations/horizontal-scaling.md) guide for production deployment details.

## Configuration

All configuration is via `PROCELLA_*` environment variables. See `.env.example` for a complete reference.

| Variable | Default | Description |
|---|---|---|
| `PROCELLA_LISTEN_ADDR` | `:9090` | Server listen address |
| `PROCELLA_DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `PROCELLA_AUTH_MODE` | `dev` | `dev` (static tokens) or `descope` (Descope access keys) |
| `PROCELLA_DEV_AUTH_TOKEN` | *(required if dev)* | Static auth token for dev mode |
| `PROCELLA_DEV_USER_LOGIN` | `dev-user` | Dev user login name |
| `PROCELLA_DEV_ORG_LOGIN` | `dev-org` | Dev org login name |
| `PROCELLA_DEV_USERS` | | JSON array of additional dev users |
| `PROCELLA_DESCOPE_PROJECT_ID` | *(required if descope)* | Descope project ID |
| `PROCELLA_DESCOPE_MANAGEMENT_KEY` | | Descope management key — enables `pulumi login` browser flow and API token creation |
| `PROCELLA_BLOB_BACKEND` | `local` | `local` (filesystem) or `s3` (S3-compatible) |
| `PROCELLA_BLOB_LOCAL_PATH` | `./data/blobs` | Local blob storage path |
| `PROCELLA_BLOB_S3_BUCKET` | *(required if s3)* | S3 bucket name |
| `PROCELLA_BLOB_S3_ENDPOINT` | | Custom S3 endpoint (MinIO, R2, etc.) |
| `PROCELLA_BLOB_S3_REGION` | `us-east-1` | S3 region |
| `PROCELLA_ENCRYPTION_KEY` | *(auto in dev)* | 64 hex chars (32 bytes) for AES-256-GCM |
| `PROCELLA_CORS_ORIGINS` | *(unrestricted)* | Comma-separated allowed CORS origins |

Encryption keys are auto-generated in dev mode via `mise` (see `mise.toml`). For production, generate one with `openssl rand -hex 32`.

## Quality Gates

```bash
bun run check          # biome lint + typecheck + 320 unit tests
bun run e2e            # E2E acceptance tests (89 tests)
bun run check:all      # check + e2e
```

## Documentation

Full documentation is available in the [`apps/docs/`](apps/docs/) directory, built with [Starlight](https://starlight.astro.build/):

```bash
bun run docs:dev       # Start docs dev server
bun run docs:build     # Build static docs site
```

- [Introduction](apps/docs/src/content/docs/getting-started/introduction.md)
- [Quick Start](apps/docs/src/content/docs/getting-started/quickstart.md)
- [Configuration](apps/docs/src/content/docs/getting-started/configuration.md)
- [Architecture Overview](apps/docs/src/content/docs/architecture/overview.md)
- [API Reference](apps/docs/src/content/docs/api/stacks.md)

## Project Structure

```
packages/
  types/              Pulumi protocol types + domain types + errors
  config/             Zod-validated env config (PROCELLA_*)
  db/                 Drizzle schema + Bun.sql connection factory
  crypto/             AES-256-GCM with HKDF per-stack key derivation
  storage/            Blob storage (local filesystem + S3)
  auth/               Dev mode (static token) + Descope (JWT)
  stacks/             Stack CRUD, rename, tags (PostgreSQL)
  updates/            Update lifecycle, checkpoints, events, GC worker
apps/
  api/                @procella/api — tRPC router (stacks, updates, events)
  server/             @procella/server — Hono HTTP server (CLI + tRPC + middleware)
  ui/                 @procella/ui — React SPA (Vite + Tailwind + tRPC client)
                      Pages: StackList, StackDetail, UpdateDetail, Tokens, Settings, CliLogin
examples/             Pulumi YAML example programs (7 examples)
e2e/                  E2E acceptance tests (89 tests, 9 files)
  docs/               @procella/docs — Starlight documentation site
```

## License

See [LICENSE](LICENSE) for details.
