// @procella/api — updates.list + updates.latest tRPC procedures.

import type { Database } from "@procella/db";
import { updateEvents, updates } from "@procella/db";

import { TRPCError, tracked } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { z } from "zod/v4";
import type { NotificationHub, NotificationStream, NotifyChannel } from "../notifications.js";
import { protectedProcedure, router } from "../trpc.js";

// ============================================================================
// Input Schema
// ============================================================================

const stackInput = z.object({
	org: z.string(),
	project: z.string(),
	stack: z.string(),
});

/**
 * Upper bound on a subscription's lifetime when the transport gives us no
 * abort signal — matches the previous inline ceiling.
 */
const MAX_SUBSCRIPTION_LIFETIME_MS = 3_600_000;

// ============================================================================
// Helpers
// ============================================================================

/** Extract resourceChanges from a summary event's fields. */
function parseResourceChanges(fields: unknown): Record<string, number> {
	if (!fields || typeof fields !== "object") return {};
	const f = fields as { summaryEvent?: { resourceChanges?: Record<string, number> } };
	return f.summaryEvent?.resourceChanges ?? {};
}

/**
 * Open a notification stream, or null when the client disconnected while the
 * listener was still being set up — there is nothing left to stream then, and
 * the hub has already released the subscription slot.
 */
async function openNotificationStream(
	notifications: NotificationHub,
	channel: NotifyChannel,
	key: string,
	signal: AbortSignal,
): Promise<NotificationStream | null> {
	try {
		return await notifications.subscribe(channel, key, signal);
	} catch (error) {
		if (signal.aborted) return null;
		throw error;
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUpdateId(
	db: Database,
	stackId: string,
	updateIdOrVersion: string,
): Promise<string> {
	if (UUID_RE.test(updateIdOrVersion)) {
		const [row] = await db
			.select({ id: updates.id })
			.from(updates)
			.where(and(eq(updates.stackId, stackId), eq(updates.id, updateIdOrVersion)))
			.limit(1);
		if (!row) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Update not found" });
		}
		return row.id;
	}

	const version = Number(updateIdOrVersion);
	if (!Number.isInteger(version) || version <= 0) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid update identifier" });
	}

	const [row] = await db
		.select({ id: updates.id })
		.from(updates)
		.where(
			and(
				eq(updates.stackId, stackId),
				eq(updates.version, version),
				// Pulumi preview permalinks use the opaque update ID; numeric permalinks are updates.
				ne(updates.kind, "preview"),
			),
		)
		.orderBy(desc(updates.createdAt))
		.limit(1);

	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: `Update version ${version} not found` });
	}
	return row.id;
}

// ============================================================================
// Updates Router
// ============================================================================

export const updatesRouter = router({
	list: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		// Resolve stack to verify access and get stackId
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		// Query updates directly for dashboard-specific fields
		const rows = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt));

		if (rows.length === 0) return [];

		// Batch-fetch summary events for all updates to populate resourceChanges
		const updateIds = rows.map((r) => r.id);
		const summaryRows = await ctx.db
			.select({
				updateId: updateEvents.updateId,
				fields: updateEvents.fields,
				sequence: updateEvents.sequence,
			})
			.from(updateEvents)
			.where(and(inArray(updateEvents.updateId, updateIds), eq(updateEvents.kind, "summary")))
			.orderBy(desc(updateEvents.sequence));

		// Keep only the latest (highest sequence) summary per update
		const resourceChangesMap = new Map<string, Record<string, number>>();
		for (const row of summaryRows) {
			if (!resourceChangesMap.has(row.updateId)) {
				resourceChangesMap.set(row.updateId, parseResourceChanges(row.fields));
			}
		}

		return rows.map((row) => ({
			updateID: row.id,
			kind: row.kind,
			result: row.result ?? "",
			version: row.version,
			message: row.message ?? "",
			startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
			endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
			resourceChanges: resourceChangesMap.get(row.id) ?? {},
			initiatedBy: row.initiatedBy ?? null,
			initiatedByType: row.initiatedByType ?? null,
			initiatedByDisplay: row.initiatedByDisplay ?? null,
		}));
	}),

	latest: protectedProcedure.input(stackInput).query(async ({ ctx, input }) => {
		const stackInfo = await ctx.stacks.getStack(
			ctx.caller.tenantId,
			input.org,
			input.project,
			input.stack,
		);

		const [row] = await ctx.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackInfo.id))
			.orderBy(desc(updates.createdAt))
			.limit(1);

		if (!row) {
			return null;
		}

		// Fetch summary event for this update
		const [summaryRow] = await ctx.db
			.select({ fields: updateEvents.fields })
			.from(updateEvents)
			.where(and(eq(updateEvents.updateId, row.id), eq(updateEvents.kind, "summary")))
			.orderBy(desc(updateEvents.sequence))
			.limit(1);

		return {
			updateID: row.id,
			kind: row.kind,
			result: row.result ?? "",
			version: row.version,
			message: row.message ?? "",
			startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
			endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
			resourceChanges: summaryRow ? parseResourceChanges(summaryRow.fields) : {},
		};
	}),

	get: protectedProcedure
		.input(
			z.object({
				org: z.string(),
				project: z.string(),
				stack: z.string(),
				updateIdOrVersion: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const stackInfo = await ctx.stacks.getStack(
				ctx.caller.tenantId,
				input.org,
				input.project,
				input.stack,
			);

			const updateId = await resolveUpdateId(ctx.db, stackInfo.id, input.updateIdOrVersion);

			const [row] = await ctx.db
				.select()
				.from(updates)
				.where(and(eq(updates.id, updateId), eq(updates.stackId, stackInfo.id)))
				.limit(1);

			if (!row) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Update not found" });
			}

			const [summaryRow] = await ctx.db
				.select({ fields: updateEvents.fields })
				.from(updateEvents)
				.where(and(eq(updateEvents.updateId, row.id), eq(updateEvents.kind, "summary")))
				.orderBy(desc(updateEvents.sequence))
				.limit(1);

			return {
				updateID: row.id,
				kind: row.kind,
				result: row.result ?? "",
				version: row.version,
				message: row.message ?? "",
				startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
				endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
				resourceChanges: summaryRow ? parseResourceChanges(summaryRow.fields) : {},
			};
		}),

	onEvents: protectedProcedure
		.input(
			z.object({
				org: z.string(),
				project: z.string(),
				stack: z.string(),
				updateId: z.string(),
				lastEventId: z.coerce.number().nullish(),
			}),
		)
		.subscription(async function* (opts) {
			const { org, project, stack, updateId: rawUpdateId, lastEventId } = opts.input;

			const stackInfo = await opts.ctx.stacks.getStack(
				opts.ctx.caller.tenantId,
				org,
				project,
				stack,
			);
			const updateId = await resolveUpdateId(opts.ctx.db, stackInfo.id, rawUpdateId);

			let lastSeq = lastEventId ?? 0;
			const signal = opts.signal ?? AbortSignal.timeout(MAX_SUBSCRIPTION_LIFETIME_MS);
			const stream = await openNotificationStream(
				opts.ctx.notifications,
				"update_events",
				updateId,
				signal,
			);
			if (!stream) return;

			try {
				// Replay first (resumes after lastEventId), then drain on every NOTIFY.
				do {
					const rows = await opts.ctx.db
						.select({ sequence: updateEvents.sequence, fields: updateEvents.fields })
						.from(updateEvents)
						.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
						.orderBy(asc(updateEvents.sequence));

					for (const row of rows) {
						lastSeq = row.sequence;
						yield tracked(String(row.sequence), row.fields as Record<string, unknown>);
					}
				} while (await stream.wait());
			} finally {
				stream.close();
			}
		}),

	onStackActivity: protectedProcedure.input(stackInput).subscription(async function* (opts) {
		const { org, project, stack } = opts.input;

		const stackInfo = await opts.ctx.stacks.getStack(opts.ctx.caller.tenantId, org, project, stack);

		const signal = opts.signal ?? AbortSignal.timeout(MAX_SUBSCRIPTION_LIFETIME_MS);
		const stream = await openNotificationStream(
			opts.ctx.notifications,
			"stack_updates",
			stackInfo.id,
			signal,
		);
		if (!stream) return;

		try {
			while (await stream.wait()) {
				// Fetch the most recently changed update for this stack
				const [row] = await opts.ctx.db
					.select()
					.from(updates)
					.where(eq(updates.stackId, stackInfo.id))
					.orderBy(desc(updates.updatedAt))
					.limit(1);

				if (!row) continue;

				// Fetch summary event for resource changes
				const [summaryRow] = await opts.ctx.db
					.select({ fields: updateEvents.fields })
					.from(updateEvents)
					.where(and(eq(updateEvents.updateId, row.id), eq(updateEvents.kind, "summary")))
					.orderBy(desc(updateEvents.sequence))
					.limit(1);

				yield tracked(row.id, {
					updateID: row.id,
					kind: row.kind,
					result: row.result ?? "",
					version: row.version,
					message: row.message ?? "",
					startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
					endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
					resourceChanges: summaryRow ? parseResourceChanges(summaryRow.fields) : {},
				});
			}
		} finally {
			stream.close();
		}
	}),
});
