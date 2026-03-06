---
title: Quick Start
description: Get a local Strata instance running and deploy your first stack in under 5 minutes.
---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Pulumi CLI](https://www.pulumi.com/docs/install/) (v3.x)
- [mise](https://mise.jdx.dev/) (for Go toolchain management, only needed for development)

## Start the Dev Environment

```bash
git clone https://github.com/strata-iac/strata.git
cd strata
make dev
```

This starts three containers via Docker Compose:

| Container | Purpose | Port |
|---|---|---|
| `postgres` | PostgreSQL 17 database | 5432 |
| `minio` | S3-compatible blob storage | 9000 (API), 9001 (console) |
| `strata` | Strata server | 8080 |

The server runs database migrations automatically on startup.

:::tip[MinIO Console]
You can browse stored checkpoints at [http://localhost:9001](http://localhost:9001) with credentials `minioadmin` / `minioadmin`.
:::

## Log In with the Pulumi CLI

```bash
export PULUMI_ACCESS_TOKEN=devtoken123
pulumi login http://localhost:8080
```

The dev environment uses a static token (`devtoken123`) for authentication. This maps to the default dev user (`dev-user`) in the default organization (`dev-org`).

## Create and Deploy a Stack

```bash
# Create a new Pulumi project
mkdir my-infra && cd my-infra
pulumi new typescript --yes

# Deploy
pulumi up --yes

# View the stack
pulumi stack

# Export state
pulumi stack export

# Clean up
pulumi destroy --yes
pulumi stack rm --yes
```

## Verify the Setup

You can verify the server is running correctly:

```bash
# Health check
curl http://localhost:8080/healthz

# Check capabilities
curl -H "Accept: application/vnd.pulumi+8" http://localhost:8080/api/capabilities

# List stacks (requires auth)
curl -H "Accept: application/vnd.pulumi+8" \
     -H "Authorization: token devtoken123" \
     http://localhost:8080/api/user/stacks
```

## Multi-Tenant Testing

The dev environment supports multiple users and organizations out of the box:

| User | Token | Organization | Role |
|---|---|---|---|
| `dev-user` | `devtoken123` | `dev-org` | admin |
| `user-b` | `token-user-b` | `org-b` | admin |
| `viewer-user` | `token-viewer` | `dev-org` | viewer |

```bash
# Log in as user-b
export PULUMI_ACCESS_TOKEN=token-user-b
pulumi login http://localhost:8080

# Stacks are isolated per organization — user-b can only see org-b stacks
pulumi stack ls
```

## Stop the Environment

```bash
make down
```

This stops all containers and removes volumes (including database data).

## Next Steps

- [Configuration](/getting-started/configuration/) — customize the server with environment variables
- [Docker Compose](/operations/docker-compose/) — understand the dev, cluster, and deps profiles
- [Testing](/development/testing/) — run the E2E acceptance test suite
