---
title: Environment Variables
description: Comprehensive reference for all environment variables, grouped by category.
---

All Strata configuration is via environment variables. Variables prefixed with `STRATA_` are Strata-specific; others (`AWS_*`) follow standard conventions.

## Quick Reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `STRATA_LISTEN_ADDR` | `:8080` | No | Server listen address |
| `STRATA_DATABASE_URL` | — | **Yes** | PostgreSQL connection string |
| `STRATA_AUTH_MODE` | `dev` | No | `dev` or `descope` |
| `STRATA_DEV_AUTH_TOKEN` | — | If dev | Primary dev user token |
| `STRATA_DEV_USER_LOGIN` | `dev-user` | No | Primary dev user name |
| `STRATA_DEV_ORG_LOGIN` | `dev-org` | No | Primary dev org name |
| `STRATA_DEV_USERS` | — | No | JSON array of extra dev users |
| `STRATA_DESCOPE_PROJECT_ID` | — | If descope | Descope project ID |
| `STRATA_BLOB_BACKEND` | `local` | No | `local` or `s3` |
| `STRATA_BLOB_LOCAL_PATH` | `./data/blobs` | If local | Local blob directory |
| `STRATA_BLOB_S3_BUCKET` | — | If s3 | S3 bucket name |
| `STRATA_BLOB_S3_ENDPOINT` | — | No | Custom S3 endpoint |
| `STRATA_ENCRYPTION_KEY` | *(auto in dev)* | No | 64 hex chars (32 bytes) |
| `AWS_ACCESS_KEY_ID` | — | If custom endpoint | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | — | If custom endpoint | S3 secret key |

## Server

### STRATA_LISTEN_ADDR

The address and port the HTTP server binds to. Supports any format accepted by Go's `net.Listen`:

- `:8080` — listen on all interfaces, port 8080 (default)
- `127.0.0.1:8080` — localhost only
- `0.0.0.0:3000` — all interfaces, port 3000

### STRATA_DATABASE_URL

PostgreSQL connection string. Required in all modes.

```
postgres://user:password@host:5432/database?sslmode=disable
```

Common `sslmode` values:
- `disable` — no SSL (development only)
- `require` — encrypted connection, no certificate verification
- `verify-full` — encrypted + verified certificate (production recommended)

## Authentication

### STRATA_AUTH_MODE

Controls how the server validates `Authorization: token <value>` headers.

- `dev` — validate against static tokens (default)
- `descope` — exchange access keys via the Descope API

### STRATA_DEV_AUTH_TOKEN

The token for the primary dev user. Required when `STRATA_AUTH_MODE=dev`.

The primary dev user is always assigned the `admin` role in `STRATA_DEV_ORG_LOGIN`.

### STRATA_DEV_USERS

JSON array of additional users for multi-tenant development and testing:

```json
[{"token":"t1","login":"alice","org":"acme","role":"admin"}]
```

Fields:
- `token` (required) — the auth token
- `login` (required) — the user's login name
- `org` (required) — the user's organization
- `role` (optional) — `viewer`, `member` (default), or `admin`

### STRATA_DESCOPE_PROJECT_ID

Your Descope project ID. Required when `STRATA_AUTH_MODE=descope`. Used to initialize the Descope SDK client for access key validation.

## Blob Storage

### STRATA_BLOB_BACKEND

- `local` — store blobs on the local filesystem (default)
- `s3` — store blobs in an S3-compatible bucket

### STRATA_BLOB_LOCAL_PATH

Directory path for local blob storage. Created automatically if it doesn't exist. Only used when `STRATA_BLOB_BACKEND=local`.

### STRATA_BLOB_S3_BUCKET

The S3 bucket name. The bucket must already exist. Required when `STRATA_BLOB_BACKEND=s3`.

### STRATA_BLOB_S3_ENDPOINT

Custom S3 endpoint URL for non-AWS providers:

- MinIO: `http://minio:9000`
- Cloudflare R2: `https://<account-id>.r2.cloudflarestorage.com`

When set, path-style addressing is used and `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are required.

When not set, the standard AWS SDK credential chain is used.

## Encryption

### STRATA_ENCRYPTION_KEY

A 64-character hex string representing 32 bytes for AES-256-GCM encryption.

Generate one:
```bash
openssl rand -hex 32
```

If not set and `STRATA_AUTH_MODE=dev`, a deterministic key is derived from `sha256("strata-dev-encryption-key")`. This is not safe for production.

## AWS Credentials

### AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

Standard AWS credentials. Required when `STRATA_BLOB_S3_ENDPOINT` is set (custom S3 endpoint). For standard AWS S3, you can also use IAM roles, instance profiles, or any method supported by the AWS SDK default credential chain.
