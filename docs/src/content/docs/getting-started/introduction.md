---
title: Introduction
description: What Strata is, why self-host your Pulumi backend, and what's included.
---

Strata is a self-hosted backend for [Pulumi](https://www.pulumi.com/), the infrastructure-as-code platform. It implements the Pulumi Service API so that the standard Pulumi CLI works against it without modification — `pulumi login`, `pulumi stack init`, `pulumi up`, `pulumi destroy`, state import/export, secret encryption, and more.

## Why Self-Host?

Pulumi Cloud is the default backend for managing state, secrets, and collaboration. For teams that need to keep infrastructure state within their own network boundary — whether for compliance, data sovereignty, or cost — Strata provides a drop-in replacement.

- **Data sovereignty** — state and secrets never leave your infrastructure
- **No vendor dependency** — run on your own PostgreSQL and S3-compatible storage
- **Multi-tenant isolation** — organization-scoped access control with role-based permissions
- **Horizontal scaling** — add replicas behind a load balancer with zero configuration changes

## What Works

Strata implements the Pulumi Service API surface that the CLI uses:

| Feature | Status |
|---|---|
| `pulumi login` | ✅ |
| `pulumi stack init / ls / rm / select` | ✅ |
| `pulumi up / preview / refresh / destroy` | ✅ |
| `pulumi stack export / import` | ✅ |
| `pulumi config set --secret` | ✅ |
| `pulumi stack rename` | ✅ |
| `pulumi stack tag` | ✅ |
| `pulumi cancel` | ✅ |
| Concurrent update protection | ✅ |
| Checkpoint versioning | ✅ |
| Delta checkpoints | ✅ |
| Update event history | ✅ |
| Orphan update garbage collection | ✅ |
| Embedded web UI | ✅ |

## Tech Stack

| Component | Technology |
|---|---|
| Language | Go 1.26.1 |
| HTTP Router | [chi v5](https://github.com/go-chi/chi) |
| Database | PostgreSQL 17 ([pgx v5](https://github.com/jackc/pgx)) |
| Authentication | [Descope](https://www.descope.com/) access keys / static dev tokens |
| Encryption | AES-256-GCM + HKDF per-stack key derivation |
| Blob Storage | Local filesystem or S3-compatible (AWS S3, MinIO, Cloudflare R2) |
| Frontend | React 19 + Vite 7 + Tailwind CSS v4 |
| Load Balancer | Caddy 2 |
| Container | Multi-stage Docker build, `FROM scratch` |
| CI | GitHub Actions (lint, vuln scan, unit tests, E2E, cluster E2E) |

## Next Steps

- [Quick Start](/getting-started/quickstart/) — get a local instance running in under 5 minutes
- [Configuration](/getting-started/configuration/) — all environment variables and their defaults
- [Architecture Overview](/architecture/overview/) — how the pieces fit together
