// @procella/server — Update lifecycle handlers.

import type { StacksService } from "@procella/stacks";
import type { CompleteUpdateRequest, StartUpdateRequest, UpdateKind } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// Update Handlers
// ============================================================================

export function updateHandlers(updates: UpdatesService, stacks: StacksService) {
	return {
		createUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const kind = param(c, "kind") as UpdateKind;
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const body = await c.req.json().catch(() => ({}));
			const typedBody = body as { config?: unknown; program?: unknown };
			const result = await updates.createUpdate(
				stackInfo.id,
				kind,
				typedBody.config,
				typedBody.program,
			);
			return c.json(result);
		},

		startUpdate: async (c: Context<Env>) => {
			const updateId = param(c, "updateId");
			const body = await c.req.json<StartUpdateRequest>();
			const result = await updates.startUpdate(updateId, body);
			return c.json(result);
		},

		completeUpdate: async (c: Context<Env>) => {
			const updateId = param(c, "updateId");
			const body = await c.req.json<CompleteUpdateRequest>();
			await updates.completeUpdate(updateId, body);
			return c.body(null, 204);
		},

		cancelUpdate: async (c: Context<Env>) => {
			const updateId = param(c, "updateId");
			await updates.cancelUpdate(updateId);
			return c.body(null, 204);
		},

		getUpdate: async (c: Context<Env>) => {
			const updateId = param(c, "updateId");
			const result = await updates.getUpdate(updateId);
			return c.json(result);
		},

		getHistory: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const result = await updates.getHistory(stackInfo.id);
			return c.json(result);
		},
	};
}
