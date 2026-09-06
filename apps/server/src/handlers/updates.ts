// @procella/server — Update lifecycle handlers.

import type { StacksService } from "@procella/stacks";
import {
	type CompleteUpdateRequest,
	isTerminalUpdateStatus,
	isValidUpdateKind,
	type StartUpdateRequest,
	type UpdateProgramRequest,
} from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param, updateContext } from "./params.js";

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
			const kind = param(c, "kind");
			if (!isValidUpdateKind(kind)) {
				return c.json({ code: "invalid_kind", message: `Invalid update kind: ${kind}` }, 400);
			}
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const body = await c.req.json().catch(() => ({}));
			const typedBody = body as Partial<UpdateProgramRequest> & { program?: unknown };
			const result = await updates.createUpdate(
				stackInfo.id,
				kind,
				typedBody.config,
				typedBody.program,
				caller,
				typedBody.metadata?.environment,
			);
			return c.json(result);
		},

		startUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
			const body = await c.req.json<StartUpdateRequest>();
			const result = await updates.startUpdate(updateId, body);
			return c.json(result);
		},

		completeUpdate: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const updateId = updateCtx.updateId;
			const body = await c.req.json<CompleteUpdateRequest>();
			if (!isTerminalUpdateStatus(body.status)) {
				return c.json(
					{ code: "invalid_status", message: `Invalid terminal update status: ${body.status}` },
					400,
				);
			}
			await updates.completeUpdate(updateId, body);

			return c.body(null, 204);
		},

		cancelUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
			await updates.cancelUpdate(updateId);
			return c.body(null, 204);
		},

		getUpdate: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const updateId = param(c, "updateId");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			await updates.verifyUpdateOwnership(updateId, stackInfo.id);
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
