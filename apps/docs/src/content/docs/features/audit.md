---
title: Audit Logs
description: Automatic audit trail of all mutating operations, integrated with Descope.
---

Procella records an audit log entry for every mutating operation. This gives you a chronological trail of who did what — useful for compliance, debugging, and security reviews.

Audit logging requires Descope mode (`PROCELLA_AUTH_MODE=descope`). In dev mode, a no-op service is wired in and no events are recorded.

## Tracked Actions

| Action | Triggered by |
|---|---|
| `stack.create` | Stack created via CLI or API |
| `stack.delete` | Stack deleted |
| `stack.rename` | Stack renamed |
| `stack.export` | Stack state exported |
| `stack.import` | Stack state imported |
| `update.create` | Update/preview/refresh/destroy initiated |
| `update.start` | Update execution started |
| `update.complete` | Update completed (succeeded, failed, or cancelled) |
| `update.cancel` | Update cancelled |
| `webhook.create` | Webhook registered |
| `webhook.delete` | Webhook deleted |
| `webhook.update` | Webhook modified |

In addition, Descope automatically records auth events: logins, token creation, token revocation, user invitations, and role changes. These appear in the same audit log and don't require any configuration on your part.

## Descope Integration

When an auditable action occurs, Procella calls the Descope management API to push an audit event:

```typescript
// Pseudocode showing what Procella sends to Descope
await descopeManagementClient.audit.createEvent({
  action: "stack.create",
  type: "activity",
  actorId: user.loginId,
  tenantId: org.name,
  data: {
    org: "my-org",
    project: "my-app",
    stack: "production",
  },
});
```

Descope stores and indexes these events, making them queryable via the Descope dashboard and API with up to 30 days of retention.

This requires `PROCELLA_DESCOPE_MANAGEMENT_KEY` to be set. Without it, audit events are silently dropped.

## Viewing Audit Logs in the Dashboard

Go to **Settings** and open the **Audit Log** tab. This renders Descope's embedded audit log widget, which shows:

- Timestamp
- Actor (user login)
- Action
- Resource (org, project, stack)
- IP address and user agent (from auth events)

You can filter by action type, date range, and actor. The widget is only visible to org admins.

## Querying Audit Logs via API

```
GET /api/orgs/:org/auditlogs
```

| Parameter | Type | Description |
|---|---|---|
| `startTime` | ISO 8601 | Filter events after this time |
| `endTime` | ISO 8601 | Filter events before this time |
| `action` | string | Filter by action type (e.g. `stack.create`) |
| `user` | string | Filter by user login |
| `continuationToken` | string | Cursor for next page |
| `pageSize` | number | Results per page (default: 50, max: 200) |

```bash
curl "https://your-procella.example.com/api/orgs/my-org/auditlogs?action=update.complete&pageSize=20" \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

Response:

```json
{
  "auditLogs": [
    {
      "timestamp": "2024-03-15T10:42:00Z",
      "action": "update.complete",
      "actor": "alice",
      "org": "my-org",
      "project": "my-app",
      "stack": "production",
      "data": {
        "status": "succeeded",
        "updateId": "upd_01HQ7Z..."
      }
    }
  ],
  "continuationToken": "eyJ0c..."
}
```

## Dev Mode Behavior

When `PROCELLA_AUTH_MODE=dev`, Procella wires in `NoopAuditService`. Every audit method is a no-op — no events are sent, no errors are thrown. This means you can develop and test locally without needing Descope credentials.

If you switch to Descope mode but forget to set `PROCELLA_DESCOPE_MANAGEMENT_KEY`, audit events are also silently dropped (to avoid breaking the request that triggered the audit). A warning is logged at startup in this case.

## Retention

Descope retains audit events for 30 days. This is a platform limitation and can't be extended. If you need longer retention, export logs periodically via the API and store them in a data warehouse or object storage.
