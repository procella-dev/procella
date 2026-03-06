---
title: Encryption
description: AES-256-GCM encryption with HKDF per-stack key derivation for secrets at rest.
---

Strata encrypts Pulumi secrets at rest using AES-256-GCM with per-stack key derivation. When you run `pulumi config set --secret`, the CLI sends the plaintext to the server, which encrypts it before storing.

## How It Works

### Key Hierarchy

```
Master Key (32 bytes, from STRATA_ENCRYPTION_KEY)
    │
    ├── HKDF(masterKey, salt="org/project/stack", info="strata-encrypt")
    │   └── Stack-specific key (32 bytes) → AES-256-GCM
    │
    ├── HKDF(masterKey, salt="org/project/other-stack", info="strata-encrypt")
    │   └── Different stack-specific key (32 bytes) → AES-256-GCM
    │
    └── ... one derived key per stack
```

A single master key derives unique encryption keys per stack using [HKDF](https://datatracker.ietf.org/doc/html/rfc5869) (HMAC-based Key Derivation Function):

- **Hash**: SHA-256
- **Input Key Material (IKM)**: The master key (32 bytes)
- **Salt**: The stack's fully qualified name (`org/project/stack`)
- **Info**: `"strata-encrypt"` (fixed context string)
- **Output**: 32-byte AES-256 key unique to each stack

### Encryption (AES-256-GCM)

1. Derive the stack-specific key via HKDF
2. Generate a random 12-byte nonce
3. Encrypt plaintext with AES-256-GCM using the derived key and nonce
4. Return `nonce || ciphertext+tag` as the ciphertext blob

### Decryption

1. Derive the same stack-specific key via HKDF
2. Split the blob: first 12 bytes = nonce, remainder = ciphertext+tag
3. Decrypt with AES-256-GCM
4. GCM's authentication tag verifies integrity — tampered ciphertext is rejected

## API Endpoints

### Encrypt

```
POST /api/stacks/{org}/{project}/{stack}/encrypt
```

- **Request**: `{"plaintext": "<base64>"}` — `Plaintext` is `[]byte`, JSON-encoded as base64
- **Response**: `{"ciphertext": "<base64>"}`

### Decrypt

```
POST /api/stacks/{org}/{project}/{stack}/decrypt
```

- **Request**: `{"ciphertext": "<base64>"}`
- **Response**: `{"plaintext": "<base64>"}`

### Batch Decrypt

```
POST /api/stacks/{org}/{project}/{stack}/batch-decrypt
```

Decrypts multiple values in a single request. Used by the CLI when displaying stack outputs or config values.

## Master Key Configuration

### Development Mode

If `STRATA_ENCRYPTION_KEY` is not set and `STRATA_AUTH_MODE=dev`, a deterministic key is auto-generated:

```go
h := sha256.Sum256([]byte("strata-dev-encryption-key"))
// h[:] is used as the 32-byte master key
```

This means all dev instances with no explicit key will share the same encryption key — convenient for development, but **not safe for production**.

### Production

Generate a random 32-byte key and set it as 64 hex characters:

```bash
export STRATA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
```

:::danger
The master key cannot be rotated without re-encrypting all existing secrets. Losing this key means losing access to all encrypted stack secrets. Store it in a secure secrets manager (Vault, AWS Secrets Manager, etc.) and back it up.
:::

## Security Properties

| Property | Guarantee |
|---|---|
| **Confidentiality** | AES-256-GCM encryption |
| **Integrity** | GCM authentication tag detects tampering |
| **Key isolation** | HKDF ensures each stack has a unique key — compromising one stack's ciphertext doesn't help with another |
| **Nonce uniqueness** | 12-byte random nonce per encryption; 96-bit random nonce has negligible collision probability under normal usage |
| **Timing safety** | Go's `crypto/cipher` uses constant-time operations |

## NopService

If no encryption key is configured and the server is not in dev mode, a `NopService` is used that returns errors for all encrypt/decrypt operations. This prevents accidental plaintext storage — the Pulumi CLI will fail with a clear error when trying to set secrets.
