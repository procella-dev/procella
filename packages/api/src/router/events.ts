// @procella/api — events.list tRPC procedure.

import { z } from "zod/v4";
import { protectedProcedure, router } from "../trpc.js";
import { resolveUpdateId } from "./updates.js";

// ============================================================================
// Events Router
// ============================================================================

export const eventsRouter = router({
	list: protectedProcedure
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
			const stackInfo = await ctx.stacks.getStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
			);
			const updateId = await resolveUpdateId(ctx.db, stackInfo.id, input.updateID);

			const result = await ctx.updates.getUpdateEvents(updateId, input.continuationToken);

			return {
				events: result.events ?? [],
				continuationToken: (result as { continuationToken?: string }).continuationToken,
			};
		}),
});
