// @procella/server — Stack CRUD handlers.

import type { StackInfo, StacksService } from "@procella/stacks";
import type { Stack, StackRenameRequest } from "@procella/types";
import { BadRequestError } from "@procella/types";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// Stack Handlers
// ============================================================================

export function stackHandlers(stacks: StacksService) {
	return {
		/** POST /api/stacks/:org/:project/:stack OR POST /api/stacks/:org/:project (stack in body) */
		createStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const body = await c.req.json().catch(() => ({}));
			const typedBody = body as { stackName?: string; tags?: Record<string, string> };
			// Stack name can come from URL param or request body
			const stack = c.req.param("stack") ?? typedBody.stackName ?? "";
			if (!stack) {
				throw new BadRequestError("Missing stack name in URL or body");
			}
			const result = await stacks.createStack(caller.tenantId, org, project, stack, typedBody.tags);
			return c.json(mapToStack(result, caller.orgSlug));
		},

		getStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const result = await stacks.getStack(caller.tenantId, org, project, stack);
			return c.json(mapToStack(result, caller.orgSlug));
		},

		deleteStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			await stacks.deleteStack(caller.tenantId, org, project, stack);
			return c.body(null, 204);
		},

		listStacks: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = c.req.query("organization");
			const project = c.req.query("project");
			const results = await stacks.listStacks(caller.tenantId, org, project);
			return c.json({ stacks: results.map((r) => mapToStack(r, caller.orgSlug)) });
		},

		renameStack: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const body = await c.req.json<StackRenameRequest>();
			await stacks.renameStack(caller.tenantId, org, project, stack, body.newName);
			return c.body(null, 204);
		},

		updateStackTags: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			const project = param(c, "project");
			const stack = param(c, "stack");
			const tags = await c.req.json<Record<string, string>>();
			await stacks.updateStackTags(caller.tenantId, org, project, stack, tags);
			return c.body(null, 204);
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function mapToStack(info: StackInfo, orgSlug?: string): Stack {
	return {
		id: info.id,
		orgName: orgSlug ?? info.orgName,
		projectName: info.projectName,
		stackName: info.stackName,
		tags: info.tags,
		activeUpdate: info.activeUpdateId ?? "",
		version: 0,
	} as Stack;
}
