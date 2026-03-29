// @procella/server — Event batch + get + lease handlers.

import type { StacksService } from "@procella/stacks";
import type { EngineEventBatch, RenewUpdateLeaseRequest } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param, updateContext } from "./params.js";

// ============================================================================
// Event Handlers
// ============================================================================

export function eventHandlers(updates: UpdatesService, stacks: StacksService) {
	return {
		postEvents: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.json<EngineEventBatch>();
			await updates.postEvents(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		getUpdateEvents: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
			const token = c.req.query("continuationToken");
			const result = await updates.getUpdateEvents(updateId, token ?? undefined);
			return c.json(result);
		},

		renewLease: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.json<RenewUpdateLeaseRequest>();
			const result = await updates.renewLease(updateCtx.updateId, body);
			return c.json(result);
		},
	};
}
