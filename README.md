# Strata

A self-hosted [Pulumi](https://www.pulumi.com/) backend. Run `pulumi login`, `pulumi stack init`, `pulumi up`, and every other CLI command against your own infrastructure — no Pulumi Cloud account required.

## Features

- **Full Pulumi CLI compatibility** — login, stack management, updates, previews, refreshes, destroys, state import/export
- **Multi-tenant authentication** — dev mode with static tokens or [Descope](https://www.descope.com/) access keys with tenant RBAC
- **Role-based access control** — viewer / member / admin roles enforced per-organization via HTTP method mapping
- **AES-256-GCM encryption** — per-stack key derivation via HKDF for secrets at rest
- **Horizontal scaling** — stateless Go binary behind Caddy load balancer, PostgreSQL for all shared state
- **S3-compatible blob storage** — local filesystem or any S3-compatible backend (AWS S3, MinIO, R2)
- **Embedded React UI** — single-page application served from the same binary
- **Minimal Docker image** — multi-stage build with `FROM scratch`, built-in healthcheck subcommand

## Tech Stack

| Component | Technology |
|---|---|
| Language | Go 1.26.1 |
| HTTP Router | chi v5 |
| Database | PostgreSQL 17 (pgx v5) |
| Auth | Descope Go SDK / static tokens |
| Encryption | AES-256-GCM + HKDF |
| Blob Storage | Local filesystem / S3 |
| Frontend | React 19 + Vite 7 + Tailwind CSS v4 |
| Load Balancer | Caddy 2 |
| Linting | golangci-lint v2 |
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
make check          # lint + vuln scan + build + unit tests
make e2e            # E2E acceptance tests (46 tests)
make e2e-cluster    # Cluster E2E tests (3 replicas)
make check-all      # check + e2e
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
internal/
  auth/               Authenticator interface, dev + Descope implementations
  config/             Environment variable configuration
  crypto/             AES-256-GCM encryption with HKDF key derivation
  db/                 PostgreSQL connection, embedded migrations
  http/
    handlers/         HTTP handlers (stacks, updates, crypto, user, health)
    middleware/       Auth, OrgAuth, UpdateAuth, CORS, Gzip, Logging, Recovery
    spa/              SPA handler for embedded React app
  stacks/             Stack service interface + PostgreSQL implementation
  updates/            Update lifecycle, GC worker, TTL caches
  storage/blobs/      Blob storage (local + S3)
web/                  React SPA (Vite + React 19 + Tailwind CSS v4)
e2e/                  E2E acceptance tests
docs/                 Starlight documentation site
```

## License

See [LICENSE](LICENSE) for details.
