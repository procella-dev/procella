---
title: Encryption
description: AES-256-GCM encryption with HKDF per-stack key derivation for secrets at rest.
---

Procella encrypts Pulumi secrets at rest using AES-256-GCM with per-stack key derivation. When you run `pulumi config set --secret`, the CLI sends the plaintext to the server, which encrypts it before storing.

## How It Works

### Key Hierarchy

```
Master Key (32 bytes, from PROCELLA_ENCRYPTION_KEY)
    │
    ├── v2: HKDF(masterKey, salt=stack UUID, info="procella-encrypt")
    │   └── Immutable stack-specific key (32 bytes) → AES-256-GCM
    │
    └── v1 read compatibility only: HKDF(masterKey,
        salt="canonical-org/resolved-project/resolved-stack",
        info="procella-encrypt")
```

A single master key derives unique encryption keys per stack using [HKDF](https://datatracker.ietf.org/doc/html/rfc5869) (HMAC-based Key Derivation Function):

- **Hash**: SHA-256
- **Input Key Material (IKM)**: The master key (32 bytes)
- **v2 salt**: The stack's immutable UUID
- **Legacy v1 salt**: The authenticated tenant's canonical org slug plus project and stack names from the resolved database row
- **Info**: `"procella-encrypt"` (fixed context string)
- **Output**: 32-byte AES-256 key unique to each stack

### Encryption (AES-256-GCM)

1. Derive the stack-specific v2 key from the immutable stack UUID
2. Generate a random 12-byte nonce
3. Encrypt plaintext with AES-256-GCM using the derived key and nonce
4. Return `0x02 || nonce || ciphertext || tag` as the ciphertext blob

### Decryption

Procella first attempts the versioned v2 format. Legacy v1 blobs have no version byte, so a v1 nonce can begin with `0x02`; if v2 authentication fails, Procella tries v1 with the canonical legacy identity. GCM authentication rejects ciphertext derived for any other identity.

The request path's `org` segment is never used as legacy key material by itself. In dev mode, the tenant ID and org slug are the same unique value. Descope deployments must register every v1 tenant in `PROCELLA_LEGACY_ORG_MAPPINGS`, a deployment-owned one-to-one map from signed tenant ID to the original canonical org slug. Procella rejects duplicate mapped slugs, mapped slugs equal to mapped tenant IDs, and unmapped tenant-ID fallbacks that collide with a mapped slug. It accepts the configured identity only when JWT tenant metadata is absent or resolves to the same value, then combines it with project and stack names from the tenant-scoped resolved stack row.

Without a unique mapping, v2 encryption and decryption continue using the stack UUID, but v1 fallback fails closed with `stack_not_found`. This prevents another tenant with a colliding display-name slug and matching project/stack names from entering the victim's legacy KDF namespace.

### Remediating ambiguous legacy identity

For each Descope tenant with v1 values, add its signed tenant ID and original org slug to `PROCELLA_LEGACY_ORG_MAPPINGS`. Verify no other mapping uses that slug; configuration validation rejects duplicates. Configure issued JWTs so `tenant_name`, `tenants.<tenantId>.name`, and any `procellaOrgSlug` claim either agree with the mapping or are absent. Then restart every replica, sign in again, and rotate CLI access keys so stale embedded aliases are removed. Do not substitute the request URL's org segment; it is untrusted.

If a v1 stack was encrypted under a retired org alias, temporarily change only that tenant's mapping and trusted claim sources back to the exact original slug. The one-to-one mapping must remain valid, and the restoration window must be limited to this stack migration. With a fresh access key and the stack selected, rewrite that stack only:

```bash
pulumi stack export --file procella-v1-backup.json
read -rsp "Temporary Pulumi passphrase: " PULUMI_CONFIG_PASSPHRASE && echo
export PULUMI_CONFIG_PASSPHRASE
pulumi stack change-secrets-provider passphrase
pulumi stack change-secrets-provider default
unset PULUMI_CONFIG_PASSPHRASE
pulumi preview
```

The first provider change decrypts legacy values while the restored canonical identity is available; the second writes v2 service ciphertext keyed by stack UUID. Keep the encrypted backup until `pulumi preview` succeeds, then delete it securely. Repeat deliberately per affected stack; Procella does not guess aliases or run a fleet-wide rewrite.

After every stack that can contain v1 values has completed this rewrite and validation, set `PROCELLA_LEGACY_DECRYPTION_ENABLED=false` on every replica and restart Procella. This keeps v2 decryption enabled but removes the v1 fallback. Roll back by setting it to `true` if an unmigrated v1 value is found; do not rotate the master key during this process.

## API Endpoints

### Encrypt

```
POST /api/stacks/{org}/{project}/{stack}/encrypt
```

- **Request**: `{"plaintext": "<base64>"}` — The `plaintext` field is a byte array, JSON-encoded as base64
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

If `PROCELLA_ENCRYPTION_KEY` is not set and `PROCELLA_AUTH_MODE=dev`, a deterministic key is auto-generated:

```typescript
import { createHash } from "node:crypto";
const key = createHash("sha256").update("procella-dev-encryption-key").digest("hex");
// key is used as the 64-char hex master key
```

This means all dev instances with no explicit key will share the same encryption key — convenient for development, but **not safe for production**.

### Production

Generate a random 32-byte key and set it as 64 hex characters:

```bash
export PROCELLA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
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
| **Timing safety** | Node.js `crypto` module handles constant-time operations internally |

## NopCryptoService

If no encryption key is configured and the server is not in dev mode, a `NopCryptoService` is used that returns errors for all encrypt/decrypt operations. This prevents accidental plaintext storage — the Pulumi CLI will fail with a clear error when trying to set secrets.
