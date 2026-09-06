import { z } from "zod/v4";

const stackResourceSchema = z.object({
	org: z.string().min(1),
	project: z.string().min(1),
	stack: z.string().min(1),
});

export const subscriptionTicketScopeSchema = z.discriminatedUnion("procedure", [
	z.object({
		procedure: z.literal("updates.onEvents"),
		resource: stackResourceSchema.extend({ updateId: z.string().min(1) }),
	}),
	z.object({
		procedure: z.literal("updates.onStackActivity"),
		resource: stackResourceSchema,
	}),
]);

export type SubscriptionTicketScope = z.infer<typeof subscriptionTicketScopeSchema>;
