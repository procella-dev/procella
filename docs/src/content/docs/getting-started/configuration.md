---
title: Configuration
description: Complete reference for all Strata environment variables.
---

Strata is configured entirely through environment variables prefixed with `STRATA_`. The server validates required variables at startup and exits with a clear error message if anything is missing.

## Core Settings

| Variable | Default | Description |
|---|---|---|
| `STRATA_LISTEN_ADDR` | `:8080` | Address and port the HTTP server listens on |
| `STRATA_DATABASE_URL` | *(required)* | PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/db?sslmode=disable`) |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `STRATA_AUTH_MODE` | `dev` | Authentication mode: `dev` or `descope` |
| `STRATA_DESCOPE_PROJECT_ID` | *(required if descope)* | Descope project ID for access key validation |
| `STRATA_DEV_AUTH_TOKEN` | *(required if dev)* | Static auth token for the primary dev user |
| `STRATA_DEV_USER_LOGIN` | `dev-user` | Login name for the primary dev user |
| `STRATA_DEV_ORG_LOGIN` | `dev-org` | Organization name for the primary dev user |
| `STRATA_DEV_USERS` | *(empty)* | JSON array of additional dev users (see below) |

### Dev Users JSON Format

`STRATA_DEV_USERS` accepts a JSON array of user objects for multi-tenant development and testing:

```json
[
  {
    "token": "token-user-b",
    "login": "user-b",
    "org": "org-b",
    "role": "admin"
  },
  {
    "token": "token-viewer",
    "login": "viewer-user",
    "org": "dev-org",
    "role": "viewer"
  }
]
```

Each user object requires `token`, `login`, and `org`. The `role` field accepts `viewer`, `member` (default), or `admin`.

:::note
The primary dev user (configured via `STRATA_DEV_AUTH_TOKEN`, `STRATA_DEV_USER_LOGIN`, `STRATA_DEV_ORG_LOGIN`) is always registered as an `admin`. Additional users from `STRATA_DEV_USERS` default to `member` if no role is specified.
:::

## Blob Storage

| Variable | Default | Description |
|---|---|---|
| `STRATA_BLOB_BACKEND` | `local` | Blob storage backend: `local` or `s3` |
| `STRATA_BLOB_LOCAL_PATH` | `./data/blobs` | Directory for local blob storage |
| `STRATA_BLOB_S3_BUCKET` | *(required if s3)* | S3 bucket name for checkpoint storage |
| `STRATA_BLOB_S3_ENDPOINT` | *(empty)* | Custom S3 endpoint (for MinIO, R2, etc.) |

When using `s3` with a custom endpoint, you must also set the standard AWS credentials:

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |

:::caution
Local blob storage stores checkpoints on the server's filesystem. This does **not** work with multiple replicas — use S3 for horizontal scaling.
:::

## Encryption

| Variable | Default | Description |
|---|---|---|
| `STRATA_ENCRYPTION_KEY` | *(auto in dev)* | 64 hex characters (32 bytes) for AES-256-GCM master key |

In dev mode, if `STRATA_ENCRYPTION_KEY` is not set, a deterministic key is generated from `sha256("strata-dev-encryption-key")`. This is convenient for development but **must not be used in production**.

### Generating a Production Key

```bash
# Generate a random 32-byte key as 64 hex characters
openssl rand -hex 32
```

:::danger
The encryption key is used to derive per-stack keys via HKDF. Losing this key means losing access to all encrypted secrets. Back it up securely.
:::

## Validation Rules

The server enforces these constraints at startup:

- `STRATA_DATABASE_URL` is always required
- `STRATA_BLOB_BACKEND` must be `local` or `s3`
- `STRATA_BLOB_LOCAL_PATH` is required when `STRATA_BLOB_BACKEND=local`
- `STRATA_BLOB_S3_BUCKET` is required when `STRATA_BLOB_BACKEND=s3`
- `STRATA_AUTH_MODE` must be `dev` or `descope`
- `STRATA_DESCOPE_PROJECT_ID` is required when `STRATA_AUTH_MODE=descope`
- `STRATA_DEV_AUTH_TOKEN` is required when `STRATA_AUTH_MODE=dev`
- `STRATA_ENCRYPTION_KEY`, if set, must be exactly 64 hex characters (32 bytes)

## Example: Minimal Production Config

```bash
export STRATA_LISTEN_ADDR=":8080"
export STRATA_DATABASE_URL="postgres://strata:secret@db.internal:5432/strata?sslmode=require"
export STRATA_AUTH_MODE="descope"
export STRATA_DESCOPE_PROJECT_ID="P3Aaha02iJvkGVbPDAF78KWuAxe6"
export STRATA_BLOB_BACKEND="s3"
export STRATA_BLOB_S3_BUCKET="my-strata-checkpoints"
export STRATA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
```
