---
title: Testing
description: Unit tests, E2E acceptance tests, cluster tests, and CI pipeline.
---

Strata has four levels of testing: Go unit tests, web unit tests, E2E acceptance tests (single server), and cluster E2E tests (multi-replica).

## Go Unit Tests

```bash
make test
# or: mise exec -- go test -race -count=1 ./...
```

Go unit tests use the standard `testing` package with table-driven patterns. They run without any external dependencies (no database, no Docker).

Key test suites:
- `internal/auth/descope_test.go` — 12 tests for Descope authenticator (mocked SDK)
- `internal/crypto/aes_test.go` — 6 tests for AES-256-GCM encryption
- `internal/http/handlers/*_test.go` — handler tests with httptest
- `internal/storage/blobs/*_test.go` — blob storage tests

All Go tests run with `-race` to detect data races.

## Web Unit Tests

```bash
make check-web
# or: cd web/apps/api && bun test
```

The tRPC web API (`@strata/api`) has 28 unit tests using Bun's built-in test runner. Tests use `appRouter.createCaller(ctx)` to invoke procedures directly without HTTP, with a chainable Proxy-based mock for the Drizzle database.

Key test suites:
- `web/apps/api/src/__tests__/stacks.test.ts` — stacks.list and stacks.get procedures
- `web/apps/api/src/__tests__/updates.test.ts` — updates.list and updates.latest procedures
- `web/apps/api/src/__tests__/events.test.ts` — events.list with continuation token logic
- `web/apps/api/src/__tests__/auth.test.ts` — dev mode authentication
- `web/apps/api/src/__tests__/helpers.ts` — test utilities (mockDb, staticDb, testContext)

Tests require `STRATA_DATABASE_URL` and `STRATA_DEV_AUTH_TOKEN` env vars (dummy values are fine — no real database connection is made).

## E2E Acceptance Tests

```bash
make e2e
# or: mise exec -- go test -race -count=1 -tags=e2e -timeout=15m -v ./e2e/...
```

E2E tests exercise the full Pulumi CLI lifecycle against an in-process Strata server. They require:
- PostgreSQL (started via `make deps` or Docker Compose)
- Pulumi CLI installed
- `STRATA_DATABASE_URL` environment variable (or use `make e2e` which connects to the Docker Compose PostgreSQL)

### Test Files

| File | Coverage |
|---|---|
| `e2e_test.go` | Test infrastructure, server setup/teardown |
| `login_test.go` | `pulumi login` validation |
| `healthz_test.go` | Health endpoint |
| `stack_lifecycle_test.go` | Create, list, get, delete stacks |
| `stack_rename_test.go` | Stack rename operations |
| `update_lifecycle_test.go` | Full update flow: create → start → checkpoint → events → complete |
| `state_operations_test.go` | Export, import, versioned export |
| `encrypt_decrypt_test.go` | Secret encryption/decryption |
| `cancel_test.go` | Update cancellation + GC |
| `multi_tenant_test.go` | Cross-org isolation, role-based access |
| `examples_test.go` | Real Pulumi programs (pulumi-random, pulumi-command) |
| `cluster_test.go` | Multi-instance specific tests |

### Test Count

46 tests covering the full Pulumi CLI lifecycle, multi-tenant isolation, and edge cases.

### Example Programs

The `examples_test.go` file deploys real Pulumi programs using:
- **pulumi-random** — generates random resources (no cloud provider needed)
- **pulumi-command** — runs local shell commands

This validates the complete update lifecycle end-to-end without requiring cloud provider credentials.

## Cluster E2E Tests

```bash
make e2e-cluster
```

Runs the same 46 E2E tests against a multi-replica Docker cluster:

1. `docker compose --profile cluster up --build -d` — starts 3 Strata replicas + Caddy LB + PostgreSQL + MinIO
2. Waits for `http://localhost:8080/healthz` to return 200
3. Runs tests with `STRATA_E2E_URL=http://localhost:8080`
4. Tears down the cluster regardless of test outcome

This validates that all operations work correctly when requests are load-balanced across multiple replicas.

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs four jobs:

### 1. Go Lint & Unit Tests (`check`)

```yaml
- uses: jdx/mise-action@v2
- run: mise exec -- make check
```

Runs: golangci-lint → govulncheck → go build → go test (unit only)

### 2. Web Lint, Typecheck & Tests (`web-check`)

```yaml
- uses: jdx/mise-action@v2
- run: mise exec -- make check-web
```

Runs: bun install → biome check → tsc --noEmit (both apps) → bun test (28 tests)

### 3. E2E Acceptance Tests (`e2e`)

```yaml
services:
  postgres:
    image: postgres:17-alpine
- uses: pulumi/setup-pulumi@v2
- run: mise exec -- go test -race -count=1 -tags=e2e -timeout=15m -v ./e2e/...
```

Uses GitHub Actions service containers for PostgreSQL. Runs the full E2E suite against an in-process server.

### 4. E2E Cluster Tests (`e2e-cluster`)

```yaml
- run: mise exec -- make e2e-cluster
```

Runs the full Docker Compose cluster (3 replicas + Caddy + PostgreSQL + MinIO) and executes E2E tests against it.

Jobs `e2e` and `e2e-cluster` depend on `check` passing first. All jobs use Go module caching for fast builds.

## Writing New Tests

### Unit Test Pattern

```go
func TestMyFeature(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    string
        wantErr bool
    }{
        {name: "valid input", input: "foo", want: "bar"},
        {name: "empty input", input: "", wantErr: true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := MyFeature(tt.input)
            if tt.wantErr {
                require.Error(t, err)
                return
            }
            require.NoError(t, err)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

### E2E Test Pattern

E2E tests use the `e2e` build tag and interact with the server via HTTP or the Pulumi CLI:

```go
//go:build e2e

package e2e

func TestMyE2EFeature(t *testing.T) {
    // Tests use shared test infrastructure from e2e_test.go
    // Server URL and auth token are available from test setup
}
```

### Running a Subset

```bash
# Run a specific test
mise exec -- go test -race -tags=e2e -timeout=15m -v -run TestStackLifecycle ./e2e/...

# Run only examples
make examples
```
