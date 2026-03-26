---
title: Webhooks
description: Outbound HTTP event delivery with HMAC-SHA256 signing and automatic retries.
---

Webhooks let Procella push event notifications to an HTTP endpoint of your choice. When something happens in your Pulumi backend — a stack update completes, a stack is deleted — Procella sends a signed POST request to your configured URL.

This is useful for triggering CI/CD pipelines, sending Slack alerts, syncing state to external systems, or building custom dashboards.

## Creating a Webhook

### Via curl

```bash
curl -X POST https://your-procella.example.com/api/orgs/my-org/hooks \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Slack Notifier",
    "url": "https://hooks.example.com/procella",
    "events": ["update.succeeded", "update.failed"],
    "secret": "my-webhook-secret"
  }'
```

The `secret` field is optional but strongly recommended. It's used to compute the `X-Webhook-Signature` header so you can verify the payload is authentic.

Set `events` to the event types you want to subscribe to.

### Via the dashboard

Go to the top-level **Webhooks** page from the main navigation. Click **Create Webhook**, fill in the URL and optional secret, and choose which event types to subscribe to.

## Event Types

| Event | Triggered when |
|---|---|
| `stack.created` | A new stack is initialized |
| `stack.deleted` | A stack is permanently deleted |
| `stack.updated` | A stack is updated |
| `update.started` | An update begins execution |
| `update.succeeded` | An update finishes with status `succeeded` |
| `update.failed` | An update finishes with status `failed` |
| `update.cancelled` | An update is cancelled |

## Payload Format

Every delivery is a `POST` with `Content-Type: application/json`. The body follows this shape:

```json
{
  "event": "update.succeeded",
  "timestamp": "2024-03-15T10:42:00Z",
  "data": {
    "org": "my-org",
    "project": "my-project",
    "stack": "production"
  }
}
```

## Delivery Headers

Every request includes these headers:

| Header | Value |
|---|---|
| `X-Webhook-Id` | Unique delivery ID (use for deduplication) |
| `X-Webhook-Event` | The event type, e.g. `update.succeeded` |
| `X-Webhook-Signature` | `sha256=<hex>` HMAC-SHA256 signature (see below) |
| `User-Agent` | `Procella-Webhooks/1.0` |
| `Content-Type` | `application/json` |

## Verifying Signatures

When you set a `secret` on the webhook, Procella computes an HMAC-SHA256 of the raw request body using that secret and sends it in `X-Webhook-Signature` as `sha256=<hex>`.

Here's how to verify it in TypeScript/Node.js:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhookSignature(
  payload: string,
  secret: string,
  signature: string
): boolean {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// In your HTTP handler:
app.post("/webhook", (req, res) => {
  const rawBody = req.body; // must be the raw string, not parsed JSON
  const sig = req.headers["x-webhook-signature"] as string;

  if (!verifyWebhookSignature(rawBody, process.env.WEBHOOK_SECRET!, sig)) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(rawBody);
  // handle event...
  res.sendStatus(200);
});
```

Use `timingSafeEqual` to prevent timing attacks. Reject any request where the signature doesn't match.

## Retry Behavior

Procella considers a delivery successful when your endpoint returns any `2xx` status code within 10 seconds.

If the delivery fails (non-2xx response, timeout, or connection error), Procella retries up to 3 attempts with exponential backoff and a 10-second timeout per attempt:

| Attempt | Delay |
|---|---|
| 2nd attempt | 1 second |
| 3rd attempt | 2 seconds |

After 3 failed attempts, the delivery is marked as `failed` and no further retries occur. You can manually re-deliver from the delivery history view.

## Managing Webhooks

### List webhooks

```bash
curl https://your-procella.example.com/api/orgs/my-org/hooks \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

### Update a webhook

```bash
curl -X PUT https://your-procella.example.com/api/orgs/my-org/hooks/wh_01HQ7Z... \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"events": ["update.failed"]}'
```

### Delete a webhook

```bash
curl -X DELETE https://your-procella.example.com/api/orgs/my-org/hooks/wh_01HQ7Z... \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

### Ping a webhook

Ping sends a synthetic `ping` event to verify your endpoint is reachable:

```bash
curl -X POST https://your-procella.example.com/api/orgs/my-org/hooks/wh_01HQ7Z.../ping \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN"
```

## Viewing Delivery History

Open the webhook detail page in the dashboard (**Webhooks** > click a webhook). You'll see a chronological list of deliveries with:

- Timestamp
- Event type
- HTTP status code your endpoint returned
- Response time
- Request and response body (expandable)

Failed deliveries have a **Redeliver** button.

## Example: Slack Notifications

Here's a minimal Express server that forwards `update.succeeded` and `update.failed` events to a Slack Incoming Webhook:

```typescript
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = express();
app.use(express.text({ type: "application/json" }));

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const SLACK_URL = process.env.SLACK_WEBHOOK_URL!;

app.post("/procella-webhook", async (req, res) => {
  const sig = req.headers["x-webhook-signature"] as string;
  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET)
    .update(req.body, "utf8")
    .digest("hex");

  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return res.status(401).send("bad signature");
  }

  const event = JSON.parse(req.body);
  const { stack, project, organization } = event;
  const status = event.event === "update.succeeded" ? "succeeded" : "failed";
  const emoji = status === "succeeded" ? ":white_check_mark:" : ":x:";

  await fetch(SLACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emoji} *${organization}/${project}/${stack}* update ${status}`,
    }),
  });

  res.sendStatus(200);
});

app.listen(3000);
```

For GitHub PR status updates from Pulumi, see the [GitHub App](./github-app) integration which handles this automatically.
