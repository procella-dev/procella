// @procella/api — updates.list + updates.latest tRPC procedures.

import { updateEvents, updates } from "@procella/db";

import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { Client } from "pg";
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

/** Extract resourceChanges from a summary event's fields. */
function parseResourceChanges(fields: unknown): Record<string, number> {
	if (!fields || typeof fields !== "object") return {};
	const f = fields as { summaryEvent?: { resourceChanges?: Record<string, number> } };
	return f.summaryEvent?.resourceChanges ?? {};
}

// ============================================================================
// Updates Router
// ============================================================================

export const updatesRouter = router({
	list: publicProcedure.input(stackInput).query(async ({ ctx, input }) => {
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
		}));
	}),

	latest: publicProcedure.input(stackInput).query(async ({ ctx, input }) => {
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

	onEvents: publicProcedure
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
			const { org, project, stack, updateId, lastEventId } = opts.input;

			const stackInfo = await opts.ctx.stacks.getStack(
				opts.ctx.caller.tenantId,
				org,
				project,
				stack,
			);
			const owned = await opts.ctx.db
				.select({ id: updates.id })
				.from(updates)
				.where(and(eq(updates.id, updateId), eq(updates.stackId, stackInfo.id)))
				.limit(1);
			if (owned.length === 0) throw new Error("Update not found");

			let lastSeq = lastEventId ?? 0;

			const pg = new Client({ connectionString: opts.ctx.dbUrl });
			await pg.connect();
			await pg.query("LISTEN update_events");

			const notify = new EventTarget();
			pg.on("notification", (msg) => {
				if (msg.payload === updateId) notify.dispatchEvent(new Event("ping"));
			});
			pg.on("error", (err) => {
				notify.dispatchEvent(new CustomEvent("dberror", { detail: err }));
			});

			try {
				const replay = await opts.ctx.db
					.select({ sequence: updateEvents.sequence })
					.from(updateEvents)
					.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
					.orderBy(asc(updateEvents.sequence));

				for (const row of replay) {
					lastSeq = row.sequence;
					yield { seq: lastSeq, ts: Date.now() };
				}

				const signal = opts.signal!;
				while (!signal.aborted) {
					await new Promise<void>((resolve, reject) => {
						const done = () => {
							notify.removeEventListener("ping", done);
							notify.removeEventListener("dberror", onErr);
							signal.removeEventListener("abort", abort);
							resolve();
						};
						const abort = () => {
							notify.removeEventListener("ping", done);
							notify.removeEventListener("dberror", onErr);
							signal.removeEventListener("abort", abort);
							reject(new DOMException("Aborted", "AbortError"));
						};
						const onErr = (e: Event) => {
							notify.removeEventListener("ping", done);
							notify.removeEventListener("dberror", onErr);
							signal.removeEventListener("abort", abort);
							reject((e as CustomEvent).detail ?? new Error("DB connection error"));
						};
						notify.addEventListener("ping", done, { once: true });
						notify.addEventListener("dberror", onErr, { once: true });
						signal.addEventListener("abort", abort, { once: true });
					});

					const newRows = await opts.ctx.db
						.select({ sequence: updateEvents.sequence })
						.from(updateEvents)
						.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
						.orderBy(asc(updateEvents.sequence));

					for (const row of newRows) {
						lastSeq = row.sequence;
						yield { seq: lastSeq, ts: Date.now() };
					}
				}
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") return;
				throw e;
			} finally {
				await pg.end().catch(() => {});
			}
		}),
});
