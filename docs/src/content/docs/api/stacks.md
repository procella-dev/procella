---
title: Stack API
description: Stack CRUD endpoints — create, list, get, delete, rename, and tag management.
---

All stack API endpoints require:
- `Accept: application/vnd.pulumi+8` header
- `Authorization: token <api-token>` header

The `{org}` parameter in the URL determines which organization is being accessed. The OrgAuth middleware checks that the authenticated user has the required role in that organization.

## Create Stack

```
POST /api/stacks/{org}/{project}
```

Creates a new stack. Auto-creates the organization and project if they don't exist (via `INSERT ON CONFLICT DO NOTHING`).

**Required role**: `member`

**Request body**:
```json
{
  "stackName": "dev"
}
```

**Response** (200):
```json
{
  "id": "org/project/dev",
  "orgName": "org",
  "projectName": "project",
  "stackName": "dev",
  "tags": {},
  "version": 0
}
```

**Errors**:
- `409 Conflict` — stack already exists

## Check Project Exists

```
HEAD /api/stacks/{org}/{project}
```

Returns 200 if the project exists, 404 otherwise. Used by the CLI to check if a project namespace is available.

**Required role**: `viewer`

## Get Stack

```
GET /api/stacks/{org}/{project}/{stack}
```

Returns stack metadata.

**Required role**: `viewer`

**Response** (200):
```json
{
  "orgName": "org",
  "projectName": "project",
  "stackName": "dev",
  "tags": {"pulumi:project": "my-project"},
  "version": 5,
  "activeUpdate": ""
}
```

## Delete Stack

```
DELETE /api/stacks/{org}/{project}/{stack}
```

Deletes a stack and all associated data (updates, events, checkpoints) via cascade.

**Required role**: `admin`

**Errors**:
- `404 Not Found` — stack doesn't exist
- `409 Conflict` — stack has an active update in progress

## List Stacks

```
GET /api/user/stacks
```

Returns all stacks the authenticated user has access to, filtered by their organization memberships.

**Required role**: `viewer` (per org)

**Response** (200):
```json
{
  "stacks": [
    {
      "orgName": "dev-org",
      "projectName": "my-project",
      "stackName": "dev",
      "tags": {},
      "version": 3,
      "activeUpdate": "",
      "lastUpdate": {
        "kind": "update",
        "status": "succeeded",
        "startTime": 1709827200
      }
    }
  ]
}
```

## Rename Stack

```
POST /api/stacks/{org}/{project}/{stack}/rename
```

Renames a stack within the same organization. Creates the target project if it doesn't exist.

**Required role**: `member`

**Request body**:
```json
{
  "newName": "org/new-project/staging"
}
```

**Response** (204): No content

**Errors**:
- `400 Bad Request` — invalid fully qualified name
- `404 Not Found` — source stack doesn't exist
- `409 Conflict` — target stack name already exists

The rename operation runs in a transaction and also creates a `rename` update record for history tracking.

## Update Tags

```
PATCH /api/stacks/{org}/{project}/{stack}/tags
```

Adds or removes tags on a stack. Tags are key-value pairs stored as JSONB.

**Required role**: `member`

**Request body**:
```json
{
  "tags": {
    "pulumi:project": "my-project",
    "environment": "staging",
    "team": "platform"
  }
}
```

**Response** (204): No content

## Common Headers

All requests must include:

```
Accept: application/vnd.pulumi+8
Authorization: token <api-token>
Content-Type: application/json  (for POST/PATCH)
```

The `PulumiAccept` middleware rejects requests to `/api/` routes that don't include the correct Accept header, returning `415 Unsupported Media Type`.
