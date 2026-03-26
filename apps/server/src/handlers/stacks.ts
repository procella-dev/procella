// @procella/server — Stack CRUD handlers.

import type { StackInfo, StacksService } from "@procella/stacks";
import type { Stack, StackRenameRequest, StackSummary } from "@procella/types";
import { BadRequestError } from "@procella/types";
import type { WebhooksService } from "@procella/webhooks";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// Stack Handlers
// ============================================================================

export function stackHandlers(stacks: StacksService, webhooks?: WebhooksService) {
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
			void webhooks?.emit({
				tenantId: caller.tenantId,
				event: "stack.created",
				data: { org, project, stack },
			});
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
			void webhooks?.emit({
				tenantId: caller.tenantId,
				event: "stack.deleted",
				data: { org, project, stack },
			});
			return c.body(null, 204);
		},

		listStacks: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = c.req.query("organization");
			const project = c.req.query("project");
			const tagName = c.req.query("tagName");
			const tagValue = c.req.query("tagValue");
			const query = c.req.query("query");
			const continuationToken = c.req.query("continuationToken");
			const pageSize = c.req.query("pageSize");
			const sortBy = c.req.query("sortBy");
			const sortOrder = c.req.query("sortOrder");

			const hasSearchParams = Boolean(
				tagName || tagValue || query || continuationToken || pageSize || sortBy || sortOrder,
			);
			if (!hasSearchParams) {
				const results = await stacks.listStacks(caller.tenantId, org, project);
				return c.json({ stacks: results.map((r) => mapToStackSummary(r, caller.orgSlug)) });
			}

			if (!stacks.searchStacks) {
				const results = await stacks.listStacks(caller.tenantId, org, project);
				return c.json({ stacks: results.map((r) => mapToStackSummary(r, caller.orgSlug)) });
			}

			const page = await stacks.searchStacks(caller.tenantId, {
				organization: org,
				project,
				tagName,
				tagValue,
				query,
				continuationToken,
				pageSize: pageSize && !Number.isNaN(Number(pageSize)) ? Number(pageSize) : undefined,
				sortBy:
					sortBy === "name" || sortBy === "lastUpdated" || sortBy === "created"
						? sortBy
						: undefined,
				sortOrder: sortOrder === "asc" || sortOrder === "desc" ? sortOrder : undefined,
			});

			return c.json({
				stacks: page.stacks.map((r) => mapToStackSummary(r, caller.orgSlug)),
				...(page.continuationToken ? { continuationToken: page.continuationToken } : {}),
			});
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

function mapToStackSummary(info: StackInfo, orgSlug?: string): StackSummary {
	return {
		id: info.id,
		orgName: orgSlug ?? info.orgName,
		projectName: info.projectName,
		stackName: info.stackName,
		lastUpdate: info.lastUpdate ?? undefined,
		resourceCount: info.resourceCount ?? undefined,
	};
}
