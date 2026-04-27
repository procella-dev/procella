// @procella/server — Event batch + get + lease handlers.

import type { StacksService } from "@procella/stacks";
import type { EngineEventBatch, RenewUpdateLeaseRequest } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param, updateContext } from "./params.js";
import { EngineEventBatchSchema, RenewUpdateLeaseRequestSchema } from "./schemas.js";

// ============================================================================
// Event Handlers
// ============================================================================

const INVALID_JSON_RESPONSE = {
	code: "invalid_request",
	message: "Body is not valid JSON",
} as const;

export function eventHandlers(updates: UpdatesService, stacks: StacksService) {
	return {
		postEvents: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = EngineEventBatchSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			await updates.postEvents(updateCtx.updateId, parseResult.data as EngineEventBatch);
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
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = RenewUpdateLeaseRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const result = await updates.renewLease(
				updateCtx.updateId,
				parseResult.data as RenewUpdateLeaseRequest,
			);
			return c.json(result);
		},
	};
}
