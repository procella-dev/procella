---
title: Encryption API
description: Encrypt, decrypt, and batch-decrypt endpoints for Pulumi secrets.
---

The encryption API handles Pulumi secrets. When you run `pulumi config set --secret`, the CLI sends the plaintext to these endpoints for server-side encryption. See [Encryption Architecture](../architecture/encryption/) for the cryptographic details.

All endpoints require:
- `Accept: application/vnd.pulumi+8`
- `Authorization: token <api-token>`

## Encrypt

```
POST /api/stacks/{org}/{project}/{stack}/encrypt
```

Encrypts a plaintext value using the stack's derived encryption key.

**Required role**: `member`

**Request body** (`apitype.EncryptValueRequest`):
```json
{
  "plaintext": "SGVsbG8gV29ybGQ="
}
```

The `plaintext` field is a byte array — JSON-encoded as **base64**.

**Response** (200, `apitype.EncryptValueResponse`):
```json
{
  "ciphertext": "dGhpcyBpcyBlbmNyeXB0ZWQ..."
}
```

The `ciphertext` field is also a byte array — JSON-encoded as base64. The raw bytes contain `nonce (12 bytes) || ciphertext + GCM tag`.

## Decrypt

```
POST /api/stacks/{org}/{project}/{stack}/decrypt
```

Decrypts a ciphertext value using the stack's derived encryption key.

**Required role**: `member`

**Request body** (`apitype.DecryptValueRequest`):
```json
{
  "ciphertext": "dGhpcyBpcyBlbmNyeXB0ZWQ..."
}
```

**Response** (200, `apitype.DecryptValueResponse`):
```json
{
  "plaintext": "SGVsbG8gV29ybGQ="
}
```

**Errors**:
- `400 Bad Request` — ciphertext is too short or malformed
- `400 Bad Request` — GCM authentication failed (tampered data or wrong key)

## Batch Decrypt

```
POST /api/stacks/{org}/{project}/{stack}/batch-decrypt
```

Decrypts multiple ciphertext values in a single request. Used by the CLI when displaying stack outputs or config values that contain secrets.

**Required role**: `member`

**Request body**:
```json
{
  "ciphertexts": [
    "dGhpcyBpcyBlbmNyeXB0ZWQ...",
    "YW5vdGhlciB2YWx1ZQ..."
  ]
}
```

**Response** (200):
```json
{
  "plaintexts": [
    "SGVsbG8gV29ybGQ=",
    "c2Vjb25kIHZhbHVl"
  ]
}
```

The order of plaintexts matches the order of ciphertexts in the request.

## Log Decryption (No-Op)

```
POST /api/stacks/{org}/{project}/{stack}/decrypt/log-decryption
```

The Pulumi CLI sends this request to log that a decryption occurred. Strata accepts it but performs no action (no-op). Returns `200 OK`.

## Error Handling

| Status | Meaning |
|---|---|
| 200 | Success |
| 400 | Invalid input (malformed ciphertext, decryption failed) |
| 401 | Missing or invalid auth token |
| 403 | Insufficient org permissions |
| 500 | Encryption service not configured |

When the encryption service is not configured (no key set, not in dev mode), all encrypt/decrypt operations return `500 Internal Server Error` with a message indicating that encryption is not available.

## Key Isolation

Each stack has its own derived encryption key. Ciphertext produced for `org/project/stack-a` cannot be decrypted using the key for `org/project/stack-b`, even though both derive from the same master key. This is enforced by HKDF using the stack's fully qualified name as the salt.
