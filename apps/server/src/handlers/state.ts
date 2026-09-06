// @procella/server — Export/import state handlers.

import type { StacksService } from "@procella/stacks";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";
import { UntypedDeploymentSchema } from "./schemas.js";

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
			const versionParam = c.req.param("version");
			let version: number | undefined;
			if (versionParam !== undefined) {
				// Pulumi's `--version` is a stack update version: a positive integer, never a
				// float, a sign, or `parseInt`'s "7junk" -> 7 prefix coercion.
				version = /^\d+$/.test(versionParam) ? Number(versionParam) : Number.NaN;
				if (!Number.isSafeInteger(version) || version <= 0) {
					return c.json(
						{ code: "invalid_request", message: "Version must be a positive integer" },
						400,
					);
				}
			}
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			const result = await updates.exportStack(stackInfo.id, version);
			return c.json(result);
		},

		importStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json({ code: "invalid_request", message: "Body is not valid JSON" }, 400);
			}
			const parseResult = UntypedDeploymentSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const result = await updates.importStack(stackInfo.id, parseResult.data);
			return c.json(result);
		},
	};
}
