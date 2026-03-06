---
title: Contributing
description: Prerequisites, setup, code style, and development workflow.
---

## Prerequisites

| Tool | Purpose |
|---|---|
| [mise](https://mise.jdx.dev/) | Tool version management (Go, golangci-lint, govulncheck) |
| [Docker](https://docs.docker.com/get-docker/) | Container runtime for dependencies and builds |
| [Node.js 22](https://nodejs.org/) | Web UI development (if modifying the frontend) |
| [Pulumi CLI](https://www.pulumi.com/docs/install/) | Required for E2E tests |

## Setup

```bash
git clone https://github.com/strata-iac/strata.git
cd strata

# Install Go toolchain via mise
mise install

# Start dependencies (PostgreSQL + MinIO)
make deps

# Run the server locally
mise exec -- go run ./cmd/strata
```

Environment variables for local development:

```bash
export STRATA_DATABASE_URL="postgres://strata:strata@localhost:5432/strata?sslmode=disable"
export STRATA_AUTH_MODE=dev
export STRATA_DEV_AUTH_TOKEN=devtoken123
export STRATA_BLOB_BACKEND=s3
export STRATA_BLOB_S3_BUCKET=strata-checkpoints
export STRATA_BLOB_S3_ENDPOINT=http://localhost:9000
export AWS_ACCESS_KEY_ID=minio
export AWS_SECRET_ACCESS_KEY=minio
```

Or just use `make dev` to run everything in Docker.

## Tool Versions

Managed by `mise.toml`:

| Tool | Version |
|---|---|
| Go | 1.26.1 |
| golangci-lint | 2.11.1 |
| govulncheck | latest |

All Go commands should be run via mise:

```bash
mise exec -- go test ./...
mise exec -- golangci-lint run ./...
```

Or use the Makefile targets which handle this automatically.

## Code Style

### Go

- **Formatting**: `gofumpt` + `goimports` (enforced by golangci-lint)
- **Linting**: golangci-lint v2 with gosec, govet, revive, noctx, and more
- **Design**: Accept interfaces, return structs
- **Errors**: Always wrap with context: `fmt.Errorf("failed to X: %w", err)`
- **Testing**: Table-driven tests with `-race` flag
- **Context**: Always use `context.Context` for cancellation and timeouts

### Interfaces

Service interfaces are defined where they are consumed (in the handler package), not where they are implemented. Keep interfaces small (1–3 methods when possible).

### Error Handling

```go
// Good — wrapped with context
if err != nil {
    return fmt.Errorf("failed to create stack %q: %w", name, err)
}

// Bad — no context
if err != nil {
    return err
}
```

## Make Targets

| Target | Description |
|---|---|
| `make dev` | Start full dev environment (Docker Compose) |
| `make deps` | Start only dependencies (PostgreSQL, MinIO) |
| `make down` | Stop dev environment + remove volumes |
| `make build` | Build Docker image |
| `make web` | Build React SPA |
| `make go-build` | Build Go binary |
| `make fmt` | Format code (golangci-lint --fix) |
| `make lint` | Run linters |
| `make lint-fix` | Run linters with auto-fix |
| `make vuln` | Run vulnerability scanner |
| `make test` | Run unit tests with race detector |
| `make e2e` | Run E2E tests (in-process server) |
| `make e2e-cluster` | Run E2E tests against Docker cluster |
| `make examples` | Run example Pulumi programs |
| `make check` | lint + vuln + build + test |
| `make check-all` | check + e2e |

## Quality Gates

Before submitting a PR, ensure:

```bash
make check      # Must pass: lint, vuln, build, unit tests
make e2e        # Must pass: 46 E2E acceptance tests
```

The CI pipeline runs `check`, `e2e`, and `e2e-cluster` on every push and PR.

## Project Layout

When adding new features, follow the existing package structure:

- **New service** → create a package under `internal/`, define the interface where it's consumed
- **New handler** → add to `internal/http/handlers/`, wire in `cmd/strata/main.go`
- **New middleware** → add to `internal/http/middleware/`
- **New migration** → add to `internal/db/migrations/` with the next sequence number
- **New E2E test** → add to `e2e/` with the `e2e` build tag

## Docker Image

The Docker image uses a multi-stage build:

1. **web-builder** (node:22-alpine) — builds the React SPA
2. **builder** (golang:1.26.1-alpine) — builds the Go binary
3. **scratch** — final image with just the binary

The `scratch` base image has no shell, no package manager, and no utilities. The Go binary includes a built-in `healthcheck` subcommand for container health monitoring.
