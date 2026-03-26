// @procella/server — Update lifecycle handlers.

import {
	buildPRCommentBody,
	type GitHubService,
	mapUpdateStatusToCommitState,
} from "@procella/github";
import type { StacksService } from "@procella/stacks";
import type { CompleteUpdateRequest, StartUpdateRequest, UpdateKind } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// Update Handlers
// ============================================================================

export function updateHandlers(
	updates: UpdatesService,
	stacks: StacksService,
	webhooks?: WebhooksService,
	github?: GitHubService | null,
) {
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
			const caller = c.get("caller");
			const updateId = param(c, "updateId");
			const body = await c.req.json<StartUpdateRequest>();
			const result = await updates.startUpdate(updateId, body);
			const org = c.req.param("org");
			const project = c.req.param("project");
			const stack = c.req.param("stack");
			if (org) {
				void webhooks?.emit({
					tenantId: caller.tenantId,
					event: "update.started",
					data: { org, project, stack, updateId },
				});
			}
			return c.json(result);
		},

		completeUpdate: async (c: Context<Env>) => {
			const updateId = param(c, "updateId");
			const body = await c.req.json<CompleteUpdateRequest>();
			await updates.completeUpdate(updateId, body);

			const caller = c.get("caller");
			const org = c.req.param("org");
			const project = c.req.param("project");
			const stack = c.req.param("stack");

			if (
				caller &&
				org &&
				project &&
				stack &&
				github &&
				(body.status === "succeeded" || body.status === "failed")
			) {
				void (async () => {
					const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
					const installation = await github.getInstallation(caller.tenantId);
					if (!installation) {
						return;
					}

					const owner = stackInfo.tags["github:owner"];
					const repo = stackInfo.tags["github:repo"];
					const pr = stackInfo.tags["github:pr"];
					const sha = stackInfo.tags["github:sha"];

					if (!owner || !repo || !pr || !sha) {
						return;
					}

					const prNumber = Number(pr);
					if (Number.isNaN(prNumber)) {
						return;
					}

					const latest = await updates.getHistory(stackInfo.id);
					const summary = latest.updates[0];
					const commitState = mapUpdateStatusToCommitState(body.status);
					await github.setCommitStatus(
						installation.installationId,
						owner,
						repo,
						sha,
						commitState,
						`Procella ${body.status}`,
					);

					const resourceChanges = summary?.resourceChanges as Record<string, number> | undefined;
					const commentBody = buildPRCommentBody({
						org,
						project,
						stack,
						kind: summary?.kind ?? "update",
						status: body.status,
						resourceChanges: {
							creates: resourceChanges?.create ?? resourceChanges?.creates,
							updates: resourceChanges?.update ?? resourceChanges?.updates,
							deletes: resourceChanges?.delete ?? resourceChanges?.deletes,
							sames: resourceChanges?.same ?? resourceChanges?.sames,
						},
					});
					await github.postPRComment(
						installation.installationId,
						owner,
						repo,
						prNumber,
						commentBody,
					);
				})().catch((error: unknown) => {
					console.error("[updates] Failed to publish GitHub update status", error);
				});
			}

			if (
				org &&
				(body.status === "succeeded" || body.status === "failed" || body.status === "cancelled")
			) {
				void webhooks?.emit({
					tenantId: org,
					event:
						body.status === "succeeded"
							? "update.succeeded"
							: body.status === "failed"
								? "update.failed"
								: "update.cancelled",
					data: { org, project, stack, updateId, status: body.status },
				});
			}
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
