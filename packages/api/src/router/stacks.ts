// @procella/api — stacks tRPC procedures (list, detail, resources, resource).

import { checkpoints, updateEvents, updates } from "@procella/db";
import type { DeploymentV3, ResourceV3 } from "@procella/types";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

// ============================================================================
// Input Schema
// ============================================================================

const stackInput = z.object({
	org: z.string(),
	project: z.string(),
	stack: z.string(),
});

// ============================================================================
// Helpers
// ============================================================================

/** Extract a human-readable name from a Pulumi URN. */
function nameFromUrn(urn: string): string {
	// URN format: urn:pulumi:stack::project::type::name
	return urn.split("::").pop() ?? urn;
}

/** Extract the provider package from a resource type token. */
function providerFromType(type: string): string {
	// Type format: provider:module:Type (e.g., aws:s3:Bucket)
	const parts = type.split(":");
	return parts[0] ?? type;
}

/** Safely parse a deployment object and extract resources. */
function extractResources(deployment: unknown): ResourceV3[] {
	if (!deployment || typeof deployment !== "object") return [];
	const d = deployment as DeploymentV3;
	return d.resources ?? [];
}

/** Pulumi secret sentinel — objects with this key contain encrypted values. */
const SECRET_SENTINEL = "4dabf18193072939515e22adb298388d";

/** Recursively redact secret values from a property bag. */
function redactSecrets(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;
	if (Array.isArray(obj)) return obj.map(redactSecrets);
	if (typeof obj === "object") {
		const record = obj as Record<string, unknown>;
		if (SECRET_SENTINEL in record) return "[secret]";
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(record)) {
			result[k] = redactSecrets(v);
		}
		return result;
	}
	return obj;
}

// ============================================================================
// Stacks Router
// ============================================================================

export const stacksRouter = router({
	list: publicProcedure.query(async ({ ctx }) => {
		const stackList = await ctx.stacks.listStacks(ctx.caller.tenantId);

		if (stackList.length === 0) {
			return [];
		}

		// Batch-fetch max checkpoint version per stack
		const stackIds = stackList.map((s) => s.id);
		const versionRows = await ctx.db
			.select({
				stackId: checkpoints.stackId,
				maxVersion: max(checkpoints.version),
			})
			.from(checkpoints)
			.where(sql`${checkpoints.stackId} IN ${stackIds}`)
			.groupBy(checkpoints.stackId);

		const versionMap = new Map(versionRows.map((r) => [r.stackId, Number(r.maxVersion ?? 0)]));

		// Batch-fetch active update kind per stack (stacks with non-null activeUpdateId)
		const activeStackIds = stackList
			.filter((s) => s.activeUpdateId !== null)
			.map((s) => s.activeUpdateId as string);

		const operationMap = new Map<string, string>();
		if (activeStackIds.length > 0) {
			const activeRows = await ctx.db
				.select({
					id: updates.id,
					kind: updates.kind,
				})
				.from(updates)
				.where(sql`${updates.id} IN ${activeStackIds}`);

			for (const row of activeRows) {
				operationMap.set(row.id, row.kind);
			}
		}

		return stackList.map((s) => ({
			orgName: s.orgName,
			projectName: s.projectName,
			stackName: s.stackName,
			version: versionMap.get(s.id) ?? 0,
			activeUpdate: s.activeUpdateId !== null,
			currentOperation: s.activeUpdateId ? (operationMap.get(s.activeUpdateId) ?? null) : null,
			tags: s.tags,
		}));
	}),

	detail: publicProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		// Get max checkpoint version
		const [versionRow] = await ctx.db
			.select({ maxVersion: max(checkpoints.version) })
			.from(checkpoints)
			.where(eq(checkpoints.stackId, stackInfo.id));

		const version = Number(versionRow?.maxVersion ?? 0);

		// Get resource count from latest checkpoint
		let resourceCount = 0;
		if (version > 0) {
			try {
				const deployment = await ctx.updates.exportStack(stackInfo.id);
				const resources = extractResources(deployment.deployment);
				// Exclude the root stack resource from the count
				resourceCount = resources.filter((r) => r.type !== "pulumi:pulumi:Stack").length;
			} catch {
				// Checkpoint may not be available — that's fine
			}
		}

		// Get latest update info
		const [latestUpdate] = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt))
			.limit(1);

		// Get resource changes from latest update's summary event
		let lastResourceChanges: Record<string, number> = {};
		if (latestUpdate) {
			const [summaryRow] = await ctx.db
				.select({ fields: updateEvents.fields })
				.from(updateEvents)
				.where(and(eq(updateEvents.updateId, latestUpdate.id), eq(updateEvents.kind, "summary")))
				.limit(1);

			if (summaryRow?.fields) {
				const fields = summaryRow.fields as {
					summaryEvent?: { resourceChanges?: Record<string, number> };
				};
				lastResourceChanges = fields.summaryEvent?.resourceChanges ?? {};
			}
		}

		return {
			orgName: stackInfo.orgName,
			projectName: stackInfo.projectName,
			stackName: stackInfo.stackName,
			version,
			resourceCount,
			tags: stackInfo.tags,
			activeUpdate: stackInfo.activeUpdateId !== null,
			currentOperation: null as string | null,
			lastUpdate: latestUpdate
				? {
						updateID: latestUpdate.id,
						kind: latestUpdate.kind,
						result: latestUpdate.result ?? "",
						message: latestUpdate.message ?? "",
						startTime: latestUpdate.startedAt
							? Math.floor(latestUpdate.startedAt.getTime() / 1000)
							: 0,
						endTime: latestUpdate.completedAt
							? Math.floor(latestUpdate.completedAt.getTime() / 1000)
							: 0,
						resourceChanges: lastResourceChanges,
					}
				: null,
		};
	}),

	resources: publicProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		let deployment: { deployment?: unknown };
		try {
			deployment = await ctx.updates.exportStack(stackInfo.id);
		} catch {
			return [];
		}

		const resources = extractResources(deployment.deployment);

		// Return sanitized resources — NO inputs/outputs to avoid leaking secrets
		return resources
			.filter((r) => r.type !== "pulumi:pulumi:Stack") // Exclude root stack resource
			.map((r) => ({
				urn: r.urn,
				type: r.type,
				name: nameFromUrn(r.urn),
				provider: providerFromType(r.type),
				parent: r.parent ? nameFromUrn(r.parent) : null,
				custom: r.custom,
				id: r.id ?? null,
				protect: r.protect ?? false,
				external: r.external ?? false,
				dependencies: (r.dependencies ?? []).length,
			}));
	}),

	resource: publicProcedure
		.input(stackInput.extend({ urn: z.string() }))
		.query(async ({ ctx, input }) => {
			const stackInfo = await ctx.stacks.getStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
			);

			let deployment: { deployment?: unknown };
			try {
				deployment = await ctx.updates.exportStack(stackInfo.id);
			} catch {
				return null;
			}

			const resources = extractResources(deployment.deployment);
			const resource = resources.find((r) => r.urn === input.urn);
			if (!resource) return null;

			// Find children (resources whose parent is this URN)
			const children = resources
				.filter((r) => r.parent === resource.urn)
				.map((r) => ({ urn: r.urn, type: r.type, name: nameFromUrn(r.urn) }));

			// Resolve dependency URNs to names
			const dependencyDetails = (resource.dependencies ?? []).map((depUrn) => {
				const dep = resources.find((r) => r.urn === depUrn);
				return {
					urn: depUrn,
					type: dep?.type ?? "unknown",
					name: nameFromUrn(depUrn),
				};
			});

			return {
				urn: resource.urn,
				type: resource.type,
				name: nameFromUrn(resource.urn),
				provider: providerFromType(resource.type),
				id: resource.id ?? null,
				custom: resource.custom,
				protect: resource.protect ?? false,
				external: resource.external ?? false,
				parent: resource.parent
					? { urn: resource.parent, name: nameFromUrn(resource.parent) }
					: null,
				children,
				dependencies: dependencyDetails,
				outputs: redactSecrets(resource.outputs ?? {}) as Record<string, unknown>,
				inputs: redactSecrets(resource.inputs ?? {}) as Record<string, unknown>,
				created: resource.created ?? null,
				modified: resource.modified ?? null,
				aliases: resource.aliases ?? [],
				initErrors: resource.initErrors ?? [],
				taint: resource.taint ?? false,
				pendingReplacement: resource.pendingReplacement ?? false,
				delete: resource.delete ?? false,
				retainOnDelete: resource.retainOnDelete ?? false,
			};
		}),
});
