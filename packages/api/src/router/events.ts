// @procella/api — events.list tRPC procedure.

import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

// ============================================================================
// Events Router
// ============================================================================

export const eventsRouter = router({
	list: publicProcedure
		.input(
			z.object({
				org: z.string(),
				project: z.string(),
				stack: z.string(),
				updateID: z.string(),
				continuationToken: z.string().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			// Resolve stack to verify access
			await ctx.stacks.getStack(ctx.caller.tenantId, input.org, input.project, input.stack);

			const result = await ctx.updates.getUpdateEvents(input.updateID, input.continuationToken);

			return {
				events: result.events ?? [],
				continuationToken: (result as { continuationToken?: string }).continuationToken,
			};
		}),
});
