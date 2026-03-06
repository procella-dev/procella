---
title: Authentication
description: Dev mode, Descope integration, role-based access control, and the update-token auth flow.
---

Strata supports two authentication modes, configured via `STRATA_AUTH_MODE`. Both modes produce the same internal `Caller` struct — the authorization layer (OrgAuth middleware) works identically regardless of which mode is active.

:::note[Design Principle]
The only difference between dev and Descope is **authentication** (who are you?), never **authorization** (what can you do?). Both modes feed into the same OrgAuth middleware and role hierarchy.
:::

## Dev Mode

When `STRATA_AUTH_MODE=dev`, the server validates tokens against a static list configured via environment variables.

The primary user is configured with:
- `STRATA_DEV_AUTH_TOKEN` — the token value
- `STRATA_DEV_USER_LOGIN` — maps to `GithubLogin` on the `Caller`
- `STRATA_DEV_ORG_LOGIN` — the user's organization

Additional users can be registered via `STRATA_DEV_USERS` (a JSON array):

```json
[
  {"token": "token-alice", "login": "alice", "org": "acme", "role": "admin"},
  {"token": "token-bob",   "login": "bob",   "org": "acme", "role": "viewer"}
]
```

Token comparison uses constant-time comparison (`crypto/subtle.ConstantTimeCompare`) to prevent timing attacks.

## Descope Mode

When `STRATA_AUTH_MODE=descope`, the server uses [Descope access keys](https://docs.descope.com/accesskeys) for authentication.

### How It Works

1. Client sends `Authorization: token <descope-access-key>`
2. `DescopeAuthenticator` calls `ExchangeAccessKey` on the Descope SDK
3. Descope validates the key and returns a JWT with tenant claims
4. Strata extracts tenant memberships and roles from the JWT:
   - Each tenant the user belongs to becomes an `OrgRole`
   - Roles are read from the tenant's `roles` array claim
   - The highest role wins: `admin > member > viewer`

### Descope Setup

1. Create a Descope project at [app.descope.com](https://app.descope.com)
2. Define tenants matching your organization names
3. Create roles: `viewer`, `member`, `admin`
4. Assign users to tenants with appropriate roles
5. Generate access keys for programmatic access
6. Set `STRATA_DESCOPE_PROJECT_ID` to your project ID

### JWT Claims Mapping

| JWT Claim | Caller Field |
|---|---|
| `email` or `name` or `sub` or token ID | `GithubLogin` (first non-empty) |
| `name` | `DisplayName` |
| `email` | `Email` |
| Token ID | `UserID` |
| Tenant memberships | `OrgMemberships[]` |

## Role Hierarchy

Three roles with a strict ordering:

| Role | Rank | Permissions |
|---|---|---|
| `viewer` | 1 | Read-only access (GET, HEAD) |
| `member` | 2 | Read + write (POST, PATCH) |
| `admin` | 3 | Full access including delete (DELETE) |

Roles are checked with `AtLeast` semantics — an `admin` satisfies a `member` requirement.

## OrgAuth Middleware

The `OrgAuth` middleware enforces organization membership and role requirements on every API request that includes an `{org}` URL parameter.

### Method-to-Role Mapping

| HTTP Method | Required Role |
|---|---|
| `GET`, `HEAD` | `viewer` |
| `POST`, `PATCH` | `member` |
| `DELETE` | `admin` |

### Flow

1. Extract `{org}` from the URL path
2. If no `{org}` parameter (e.g., `/api/user`), pass through
3. Get the `Caller` from request context (set by Auth middleware)
4. Check if the caller has a membership in the requested org with the required role
5. Return `403 Forbidden` if insufficient permissions

```
GET  /api/stacks/acme/myproject/dev   → requires viewer in "acme"
POST /api/stacks/acme/myproject       → requires member in "acme"
DELETE /api/stacks/acme/myproject/dev → requires admin in "acme"
```

## Update-Token Auth

During the execution phase of an update (after `StartUpdate`), a separate auth scheme is used:

- **Header**: `Authorization: update-token <lease-token>`
- **Validated by**: `UpdateAuth` middleware
- **Scope**: Only for checkpoint, events, renew_lease, and complete endpoints

The lease token is generated during `StartUpdate` and has an expiration time. The CLI periodically calls `renew_lease` to extend it. This ensures that crashed or abandoned updates can be detected and garbage-collected.

See [Update Lifecycle](/architecture/update-lifecycle/) for the full protocol.

## Auth Flow Summary

```
Request arrives
  │
  ├─ /healthz, /api/capabilities → No auth required
  │
  ├─ /api/* (most routes) → Auth middleware
  │    ├─ Extract "Authorization: token <key>"
  │    ├─ Validate via DevAuthenticator or DescopeAuthenticator
  │    ├─ Set Caller in context
  │    └─ OrgAuth middleware
  │         ├─ Check {org} membership
  │         └─ Check method → role mapping
  │
  └─ Execution routes (checkpoint, events, etc.) → UpdateAuth middleware
       ├─ Extract "Authorization: update-token <lease>"
       └─ Validate against database (with TTL cache)
```
