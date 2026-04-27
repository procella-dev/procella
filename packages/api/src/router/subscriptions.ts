import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc.js";

export const subscriptionsRouter = router({
	createTicket: protectedProcedure.mutation(async ({ ctx }) => {
		if (!ctx.issueSubscriptionTicket) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Subscription tickets are not enabled on this server",
			});
		}

		const issueSubscriptionTicket = ctx.issueSubscriptionTicket;

		return {
			ticket: await issueSubscriptionTicket(ctx.caller),
		};
	}),
});
