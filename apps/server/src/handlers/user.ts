// @strata/server — User endpoint handlers.

import type { StacksService } from "@strata/stacks";
import type { Context } from "hono";
import type { Env } from "../types.js";

// ============================================================================
// User Handlers
// ============================================================================

export function userHandlers(stacks: StacksService) {
	return {
		getCurrentUser: (c: Context<Env>) => {
			const caller = c.get("caller");
			return c.json({
				githubLogin: caller.login,
				name: caller.login,
				organizations: [{ githubLogin: caller.tenantId, name: caller.tenantId }],
			});
		},

		getUserStacks: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const stacksList = await stacks.listStacks(caller.tenantId);
			return c.json({ stacks: stacksList });
		},
	};
}
