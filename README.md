# Strata

A self-hosted [Pulumi](https://www.pulumi.com/) backend. Run `pulumi login`, `pulumi stack init`, `pulumi up`, and every other CLI command against your own infrastructure — no Pulumi Cloud account required.

## Features

- **Full Pulumi CLI compatibility** — login, stack management, updates, previews, refreshes, destroys, state import/export
- **Multi-tenant authentication** — dev mode with static tokens or [Descope](https://www.descope.com/) access keys with tenant RBAC
- **Role-based access control** — viewer / member / admin roles enforced per-organization via HTTP method mapping
- **AES-256-GCM encryption** — per-stack key derivation via HKDF for secrets at rest
- **Horizontal scaling** — stateless Go binary behind Caddy load balancer, PostgreSQL for all shared state
- **S3-compatible blob storage** — local filesystem or any S3-compatible backend (AWS S3, MinIO, R2)
- **Microservice architecture** — Go API for Pulumi CLI, Bun tRPC API for web dashboard, standalone React SPA
- **Minimal Docker images** — `FROM scratch` / distroless containers with built-in healthcheck

## Tech Stack

| Component | Technology |
|---|---|
| Go API | Go 1.26.1, chi v5, pgx v5 |
| Web API | Bun, Hono, tRPC, Drizzle ORM |
| Web UI | React 19, Vite 7, Tailwind CSS v4 |
| Database | PostgreSQL 17 |
| Auth | Descope / static tokens (both services) |
| Encryption | AES-256-GCM + HKDF |
| Blob Storage | Local filesystem / S3 |
| Reverse Proxy | Caddy 2 |
| Quality (Go) | golangci-lint v2 |
| Quality (Web) | Biome + TypeScript strict |
| IaC SDK | Pulumi SDK v3 (apitype definitions) |

## Quick Start

```bash
# Clone and start the dev environment
git clone https://github.com/strata-iac/strata.git
cd strata
make dev
```

This starts PostgreSQL, MinIO, and a single Strata server via Docker Compose.

```bash
# Point the Pulumi CLI at your local Strata instance
export PULUMI_ACCESS_TOKEN=devtoken123
pulumi login http://localhost:8080

# Create and deploy a stack
mkdir my-project && cd my-project
pulumi new typescript
pulumi up
```

## Running in Production

For horizontal scaling with multiple replicas behind a load balancer:

```bash
make cluster        # 3 replicas + Caddy LB + PostgreSQL + MinIO
make e2e-cluster    # Run acceptance tests against the cluster
```

See the [Horizontal Scaling](docs/src/content/docs/operations/horizontal-scaling.md) guide for production deployment details.

## Quality Gates

```bash
make check          # Go: lint + vuln scan + build + unit tests
make check-web      # Web: biome lint + typecheck + 28 unit tests
make e2e            # E2E acceptance tests (46 tests)
make e2e-cluster    # Cluster E2E tests (3 replicas)
make check-all      # check + check-web + e2e
```

## Documentation

Full documentation is available in the [`docs/`](docs/) directory, built with [Starlight](https://starlight.astro.build/):

```bash
make docs-dev       # Start docs dev server
make docs-build     # Build static docs site
```

- [Introduction](docs/src/content/docs/getting-started/introduction.md)
- [Quick Start](docs/src/content/docs/getting-started/quickstart.md)
- [Configuration](docs/src/content/docs/getting-started/configuration.md)
- [Architecture Overview](docs/src/content/docs/architecture/overview.md)
- [API Reference](docs/src/content/docs/api/stacks.md)

## Project Structure

```
cmd/strata/           Server entrypoint, healthcheck subcommand
internal/             Go backend (Pulumi CLI protocol)
  auth/               Authenticator interface, dev + Descope
  config/             Environment variable configuration
  crypto/             AES-256-GCM encryption with HKDF key derivation
  db/                 PostgreSQL connection, embedded migrations
  http/
    handlers/         HTTP handlers (stacks, updates, crypto, health)
    middleware/        Auth, CORS, Gzip, Logging, Recovery
  stacks/             Stack service + PostgreSQL implementation
  updates/            Update lifecycle, GC worker, TTL caches
  storage/blobs/      Blob storage (local + S3)
web/                  Bun workspace monorepo
  apps/api/           @strata/api — tRPC web API (Hono + Drizzle)
  apps/ui/            @strata/ui — React SPA (Vite + Tailwind)
  biome.json          Strict Biome linter/formatter config
  tsconfig.json       Strict TypeScript base config
e2e/                  E2E acceptance tests
docs/                 Starlight documentation site
```

## License

See [LICENSE](LICENSE) for details.
