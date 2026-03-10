---
title: Environment Variables
description: Comprehensive reference for all environment variables, grouped by category.
---

All Procella configuration is via environment variables. Variables prefixed with `PROCELLA_` are Procella-specific; others (`AWS_*`) follow standard conventions.

## Quick Reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `PROCELLA_LISTEN_ADDR` | `:9090` | No | Server listen address |
| `PROCELLA_DATABASE_URL` | — | **Yes** | PostgreSQL connection string |
| `PROCELLA_AUTH_MODE` | `dev` | No | `dev` or `descope` |
| `PROCELLA_DEV_AUTH_TOKEN` | — | If dev | Primary dev user token |
| `PROCELLA_DEV_USER_LOGIN` | `dev-user` | No | Primary dev user name |
| `PROCELLA_DEV_ORG_LOGIN` | `dev-org` | No | Primary dev org name |
| `PROCELLA_DEV_USERS` | — | No | JSON array of extra dev users |
| `PROCELLA_DESCOPE_PROJECT_ID` | — | If descope | Descope project ID |
| `PROCELLA_BLOB_BACKEND` | `local` | No | `local` or `s3` |
| `PROCELLA_BLOB_LOCAL_PATH` | `./data/blobs` | If local | Local blob directory |
| `PROCELLA_BLOB_S3_BUCKET` | — | If s3 | S3 bucket name |
| `PROCELLA_BLOB_S3_ENDPOINT` | — | No | Custom S3 endpoint |
| `PROCELLA_BLOB_S3_REGION` | `us-east-1` | No | S3 region |
| `PROCELLA_ENCRYPTION_KEY` | *(auto in dev)* | If non-dev | 64 hex chars (32 bytes) |
| `PROCELLA_CORS_ORIGINS` | *(unrestricted)* | No | Comma-separated allowed origins |
| `AWS_ACCESS_KEY_ID` | — | If custom endpoint | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | — | If custom endpoint | S3 secret key |

## Server

### PROCELLA_LISTEN_ADDR

The address and port the HTTP server binds to:

- `:9090` — listen on all interfaces, port 9090 (default)
- `127.0.0.1:9090` — localhost only
- `0.0.0.0:3000` — all interfaces, port 3000

### PROCELLA_DATABASE_URL

PostgreSQL connection string. Required in all modes.

```
postgres://user:password@host:5432/database?sslmode=disable
```

Common `sslmode` values:
- `disable` — no SSL (development only)
- `require` — encrypted connection, no certificate verification
- `verify-full` — encrypted + verified certificate (production recommended)

## Authentication

### PROCELLA_AUTH_MODE

Controls how the server validates `Authorization: token <value>` headers.

- `dev` — validate against static tokens (default)
- `descope` — exchange access keys via the Descope API

### PROCELLA_DEV_AUTH_TOKEN

The token for the primary dev user. Required when `PROCELLA_AUTH_MODE=dev`.

The primary dev user is always assigned the `admin` role in `PROCELLA_DEV_ORG_LOGIN`.

### PROCELLA_DEV_USERS

JSON array of additional users for multi-tenant development and testing:

```json
[{"token":"t1","login":"alice","org":"acme","role":"admin"}]
```

Fields:
- `token` (required) — the auth token
- `login` (required) — the user's login name
- `org` (required) — the user's organization
- `role` (optional) — `viewer`, `member` (default), or `admin`

### PROCELLA_DESCOPE_PROJECT_ID

Your Descope project ID. Required when `PROCELLA_AUTH_MODE=descope`. Used to initialize the Descope SDK client for access key validation.

## Blob Storage

### PROCELLA_BLOB_BACKEND

- `local` — store blobs on the local filesystem (default)
- `s3` — store blobs in an S3-compatible bucket

### PROCELLA_BLOB_LOCAL_PATH

Directory path for local blob storage. Created automatically if it doesn't exist. Only used when `PROCELLA_BLOB_BACKEND=local`.

### PROCELLA_BLOB_S3_BUCKET

The S3 bucket name. The bucket must already exist. Required when `PROCELLA_BLOB_BACKEND=s3`.

### PROCELLA_BLOB_S3_ENDPOINT

Custom S3 endpoint URL for non-AWS providers:

- MinIO: `http://minio:9000`
- Cloudflare R2: `https://<account-id>.r2.cloudflarestorage.com`

When set, path-style addressing is used and `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are required.

When not set, the standard AWS SDK credential chain is used.

### PROCELLA_BLOB_S3_REGION

The AWS region for the S3 bucket. Defaults to `us-east-1`. Only relevant when using real AWS S3 (not MinIO or other custom endpoints).

## Encryption

### PROCELLA_ENCRYPTION_KEY

A 64-character hex string representing 32 bytes for AES-256-GCM encryption.

Generate one:
```bash
openssl rand -hex 32
```

If not set and `PROCELLA_AUTH_MODE=dev`, a deterministic key is derived from `sha256("procella-dev-encryption-key")`. This is not safe for production.

When `PROCELLA_AUTH_MODE=descope` (production), this variable is **required**. The server will refuse to start without it.

## CORS

### PROCELLA_CORS_ORIGINS

Comma-separated list of allowed origins for CORS preflight responses:

```bash
PROCELLA_CORS_ORIGINS=https://dashboard.example.com,https://admin.example.com
```

When not set, all origins are permitted. For production deployments, restrict this to the origins that host your dashboard UI.

## AWS Credentials

### AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

Standard AWS credentials. Required when `PROCELLA_BLOB_S3_ENDPOINT` is set (custom S3 endpoint). For standard AWS S3, you can also use IAM roles, instance profiles, or any method supported by the AWS SDK default credential chain.
