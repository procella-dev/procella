// @strata/server — Export/import state handlers.

import type { StacksService } from "@strata/stacks";
import type { UntypedDeployment } from "@strata/types";
import type { UpdatesService } from "@strata/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// State Handlers
// ============================================================================

export function stateHandlers(updates: UpdatesService, stacks: StacksService) {
	return {
		exportStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const versionParam = c.req.param("version");
			const version = versionParam ? Number.parseInt(versionParam, 10) : undefined;
			const result = await updates.exportStack(stackInfo.id, version);
			return c.json(result);
		},

		importStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const body = await c.req.json<UntypedDeployment>();
			const result = await updates.importStack(stackInfo.id, body);
			return c.json(result);
		},
	};
}
