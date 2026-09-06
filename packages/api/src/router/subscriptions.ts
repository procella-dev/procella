import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../trpc.js";

const stackResourceSchema = z.object({
	org: z.string().min(1),
	project: z.string().min(1),
	stack: z.string().min(1),
});

export const subscriptionsRouter = router({
	createTicket: protectedProcedure
		.input(
			z.discriminatedUnion("procedure", [
				z.object({
					procedure: z.literal("updates.onEvents"),
					resource: stackResourceSchema.extend({ updateId: z.string().min(1) }),
				}),
				z.object({
					procedure: z.literal("updates.onStackActivity"),
					resource: stackResourceSchema,
				}),
			]),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.issueSubscriptionTicket) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Subscription tickets are not enabled on this server",
				});
			}

			const issueSubscriptionTicket = ctx.issueSubscriptionTicket;

			return {
				ticket: await issueSubscriptionTicket(ctx.caller, input),
			};
		}),
});
