import { BadRequestError, NotFoundError } from "@procella/types";
import type { CreateWebhookInput, WebhooksService } from "@procella/webhooks";
import type { Context } from "hono";
import { z } from "zod/v4";
import type { Env } from "../types.js";
import { param } from "./params.js";

const createWebhookSchema = z.object({
	name: z.string().min(1),
	url: z.string().url(),
	events: z.array(z.string()).min(1),
	secret: z.string().min(1).optional(),
});

const updateWebhookSchema = z.object({
	name: z.string().min(1).optional(),
	url: z.string().url().optional(),
	events: z.array(z.string()).min(1).optional(),
	secret: z.string().min(1).optional(),
});

export function webhookHandlers(deps: { webhooks: WebhooksService }) {
	return {
		createWebhook: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const body = await c.req.json().catch(() => ({}));
			const input = createWebhookSchema.parse(body) as CreateWebhookInput;
			const webhook = await deps.webhooks.createWebhook(caller.tenantId, input, caller.userId);
			return c.json(webhook, 201);
		},

		listWebhooks: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const hooks = await deps.webhooks.listWebhooks(caller.tenantId);
			return c.json({ webhooks: hooks });
		},

		getWebhook: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const hookId = param(c, "hookId");
			const hook = await deps.webhooks.getWebhook(caller.tenantId, hookId);
			if (!hook) {
				throw new NotFoundError("Webhook", hookId);
			}
			return c.json(hook);
		},

		updateWebhook: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const hookId = param(c, "hookId");
			const body = await c.req.json().catch(() => ({}));
			const updates = updateWebhookSchema.parse(body) as Partial<CreateWebhookInput>;
			const hook = await deps.webhooks.updateWebhook(caller.tenantId, hookId, updates);
			return c.json(hook);
		},

		deleteWebhook: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const hookId = param(c, "hookId");
			await deps.webhooks.deleteWebhook(caller.tenantId, hookId);
			return c.body(null, 204);
		},

		listDeliveries: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const hookId = param(c, "hookId");
			const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
			const deliveries = await deps.webhooks.listDeliveries(caller.tenantId, hookId, limit);
			return c.json({ deliveries });
		},

		ping: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			const hookId = param(c, "hookId");
			const delivery = await deps.webhooks.ping(caller.tenantId, hookId);
			return c.json(delivery);
		},
	};
}
