// @strata/api — stacks.list tRPC procedure.

import { checkpoints, updates } from "@strata/db";
import { max, sql } from "drizzle-orm";
import { publicProcedure, router } from "../trpc.js";

// ============================================================================
// Stacks Router
// ============================================================================

export const stacksRouter = router({
	list: publicProcedure.query(async ({ ctx }) => {
		const stackList = await ctx.stacks.listStacks(ctx.caller.tenantId);

		if (stackList.length === 0) {
			return [];
		}

		// Batch-fetch max checkpoint version per stack
		const stackIds = stackList.map((s) => s.id);
		const versionRows = await ctx.db
			.select({
				stackId: checkpoints.stackId,
				maxVersion: max(checkpoints.version),
			})
			.from(checkpoints)
			.where(sql`${checkpoints.stackId} IN ${stackIds}`)
			.groupBy(checkpoints.stackId);

		const versionMap = new Map(versionRows.map((r) => [r.stackId, Number(r.maxVersion ?? 0)]));

		// Batch-fetch active update kind per stack (stacks with non-null activeUpdateId)
		const activeStackIds = stackList
			.filter((s) => s.activeUpdateId !== null)
			.map((s) => s.activeUpdateId as string);

		const operationMap = new Map<string, string>();
		if (activeStackIds.length > 0) {
			const activeRows = await ctx.db
				.select({
					id: updates.id,
					kind: updates.kind,
				})
				.from(updates)
				.where(sql`${updates.id} IN ${activeStackIds}`);

			for (const row of activeRows) {
				operationMap.set(row.id, row.kind);
			}
		}

		return stackList.map((s) => ({
			orgName: s.orgName,
			projectName: s.projectName,
			stackName: s.stackName,
			version: versionMap.get(s.id) ?? 0,
			activeUpdate: s.activeUpdateId !== null,
			currentOperation: s.activeUpdateId ? (operationMap.get(s.activeUpdateId) ?? null) : null,
			tags: s.tags,
		}));
	}),
});
