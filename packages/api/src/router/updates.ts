// @procella/api — updates.list + updates.latest tRPC procedures.

import { updates } from "@procella/db";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

// ============================================================================
// Input Schema
// ============================================================================

const stackInput = z.object({
	org: z.string(),
	project: z.string(),
	stack: z.string(),
});

// ============================================================================
// Updates Router
// ============================================================================

export const updatesRouter = router({
	list: publicProcedure.input(stackInput).query(async ({ ctx, input }) => {
		// Resolve stack to verify access and get stackId
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		// Query updates directly for dashboard-specific fields
		const rows = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt));

		return rows.map((row) => ({
			updateID: row.id,
			kind: row.kind,
			result: row.result ?? "",
			version: row.version,
			message: row.message ?? "",
			startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
			endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
			resourceChanges: {} as Record<string, number>,
		}));
	}),

	latest: publicProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		const [row] = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt))
			.limit(1);

		if (!row) {
			return null;
		}

		return {
			updateID: row.id,
			kind: row.kind,
			result: row.result ?? "",
			version: row.version,
			message: row.message ?? "",
			startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
			endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
			resourceChanges: {} as Record<string, number>,
		};
	}),
});
