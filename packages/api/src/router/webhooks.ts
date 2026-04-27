import { ALL_WEBHOOK_EVENTS } from "@procella/webhooks";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { adminProcedure, router } from "../trpc.js";

const allWebhookEvents: readonly string[] = ALL_WEBHOOK_EVENTS;
const webhookEventSchema = z
	.string()
	.refine((event) => allWebhookEvents.includes(event), "Invalid webhook event");

const createWebhookInput = z.object({
	name: z.string().min(1),
	url: z.string().url(),
	events: z.array(webhookEventSchema).min(1),
	secret: z.string().min(1).optional(),
});

const updateWebhookInput = z.object({
	webhookId: z.string().uuid(),
	name: z.string().min(1).optional(),
	url: z.string().url().optional(),
	events: z.array(webhookEventSchema).min(1).optional(),
	secret: z.string().min(1).optional(),
});

const webhookIdInput = z.object({
	webhookId: z.string().uuid(),
});

export const webhooksRouter = router({
	list: adminProcedure.query(async ({ ctx }) => {
		return ctx.webhooks.listWebhooks(ctx.caller.tenantId);
	}),

	create: adminProcedure.input(createWebhookInput).mutation(async ({ ctx, input }) => {
		return ctx.webhooks.createWebhook(
			ctx.caller.tenantId,
			{
				name: input.name,
				url: input.url,
				events: input.events,
				secret: input.secret,
			},
			ctx.caller.userId,
		);
	}),

	get: adminProcedure.input(webhookIdInput).query(async ({ ctx, input }) => {
		const webhook = await ctx.webhooks.getWebhook(ctx.caller.tenantId, input.webhookId);
		if (!webhook) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
		}
		return webhook;
	}),

	update: adminProcedure.input(updateWebhookInput).mutation(async ({ ctx, input }) => {
		return ctx.webhooks.updateWebhook(ctx.caller.tenantId, input.webhookId, {
			name: input.name,
			url: input.url,
			events: input.events,
			secret: input.secret,
		});
	}),

	delete: adminProcedure.input(webhookIdInput).mutation(async ({ ctx, input }) => {
		await ctx.webhooks.deleteWebhook(ctx.caller.tenantId, input.webhookId);
		return { success: true };
	}),

	deliveries: adminProcedure
		.input(webhookIdInput.extend({ limit: z.number().int().min(1).max(200).optional() }))
		.query(async ({ ctx, input }) => {
			return ctx.webhooks.listDeliveries(ctx.caller.tenantId, input.webhookId, input.limit);
		}),

	ping: adminProcedure.input(webhookIdInput).mutation(async ({ ctx, input }) => {
		return ctx.webhooks.ping(ctx.caller.tenantId, input.webhookId);
	}),
});
