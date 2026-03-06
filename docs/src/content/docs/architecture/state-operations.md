---
title: State Operations
description: Export, import, and versioned state retrieval.
---

Strata supports the Pulumi CLI's state management commands: `pulumi stack export`, `pulumi stack import`, and versioned checkpoint retrieval.

## Export

```
GET /api/stacks/{org}/{project}/{stack}/export
```

Returns the latest checkpoint as an `apitype.UntypedDeployment`.

- **Auth**: `Authorization: token <api-token>`
- **Response**: JSON `apitype.UntypedDeployment` with `version: 3` and the deployment payload

### Empty Stacks

Stacks with no deployments return a valid `UntypedDeployment` with:
- `version: 3`
- Non-null deployment JSON (empty resource list)

This allows `pulumi stack export` to work on newly created stacks.

### Versioned Export

```
GET /api/stacks/{org}/{project}/{stack}/export/{version}
```

Returns a specific checkpoint version. Useful for debugging or rolling back to a previous state.

## Import

```
POST /api/stacks/{org}/{project}/{stack}/import
```

Imports a deployment as the stack's new state.

- **Auth**: `Authorization: token <api-token>`
- **Request body**: `apitype.UntypedDeployment`
- **Response**: `apitype.ImportStackResponse` with `UpdateID`

### How It Works

Import is a **single-shot operation** — unlike regular updates, it does not follow the create → start → complete lifecycle. The server:

1. Creates an update record with kind `import` and status `succeeded`
2. Stores the checkpoint
3. Returns the update ID

After import, the CLI polls `GET .../update/{updateID}` to confirm success. Strata returns `UpdateResults{Status: "succeeded"}` immediately.

### Cross-Stack Import

When importing state that references a different stack, the Pulumi CLI requires the `--force` flag:

```bash
pulumi stack export --stack org/project/source > state.json
pulumi stack import --stack org/project/target --force < state.json
```

The `--force` flag is a client-side safety check; Strata accepts the import regardless.

## Checkpoint Versioning

Each checkpoint operation increments the stack's `last_checkpoint_version` counter. This version is:

- Returned in `StartUpdateResponse.version` so the CLI knows the starting version
- Used as the checkpoint `version` column in the `checkpoints` table
- Available for versioned export via `GET .../export/{version}`

The version counter is atomic — incremented within the same transaction as the checkpoint write.

## Checkpoint Types

During an update, three checkpoint formats are supported:

### Standard Checkpoint
```
PATCH .../checkpoint
```
Full deployment state as `apitype.PatchUpdateCheckpointRequest`. Replaces the entire checkpoint.

### Verbatim Checkpoint
```
PATCH .../checkpointverbatim
```
`apitype.PatchUpdateVerbatimCheckpointRequest` — preserves exact JSON formatting. Includes a `sequenceNumber` for idempotency. If the same sequence number is sent twice, the second write is silently ignored (via `ON CONFLICT DO NOTHING`).

### Delta Checkpoint
```
PATCH .../checkpointdelta
```
Only the changed resources. The server applies the delta against the last full checkpoint to produce a complete state. This reduces network bandwidth for large stacks where only a few resources changed.
