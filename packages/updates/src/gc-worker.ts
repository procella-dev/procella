// @procella/updates — GC Worker for cleaning up stale/orphaned updates.

import type { Database } from "@procella/db";
import { stacks, subscriptionTicketNonces, updates } from "@procella/db";
import {
	activeUpdatesGauge,
	gcCycleCount,
	gcOrphansCleanedCount,
	gcTicketNoncesCleanedCount,
} from "@procella/telemetry";
import { projectError } from "@procella/types";
import { enqueueWebhookEvent } from "@procella/webhooks";
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { loadUpdateWebhookContext } from "./postgres.js";
import {
	GC_ADVISORY_LOCK_ID,
	GC_INTERVAL_MS,
	GC_LEASE_GRACE_MS,
	GC_STALE_THRESHOLD_MS,
	SUBSCRIPTION_TICKET_NONCE_GC_BATCH_SIZE,
} from "./types.js";

// ============================================================================
// GCWorker
// ============================================================================

export class GCWorker {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly db: Database;
	private readonly interval: number;

	constructor({ db, interval }: { db: Database; interval?: number }) {
		this.db = db;
		this.interval = interval ?? GC_INTERVAL_MS;
	}

	async start(): Promise<void> {
		await this.runBestEffortCycle();
		this.timer = setInterval(() => void this.runBestEffortCycle(), this.interval);
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		// Wait for in-flight cycle to finish
		while (this.running) {
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** Run a single GC cycle (for use by cron endpoints). */
	async runOnce(): Promise<void> {
		await this.runCycle();
	}

	private async runBestEffortCycle(): Promise<void> {
		try {
			await this.runCycle();
		} catch (err) {
			// Interval mode is best-effort: log and retry on the next cycle.
			console.error("[gc] cycle failed:", projectError(err));
		}
	}

	private async runCycle(): Promise<void> {
		if (this.running) return;
		this.running = true;
		gcCycleCount().add(1);

		try {
			const result = await this.db.transaction(async (tx) => {
				const lockResult = await tx.execute(
					sql`SELECT pg_try_advisory_xact_lock(${GC_ADVISORY_LOCK_ID}) as acquired`,
				);
				const rows = "rows" in lockResult ? lockResult.rows : lockResult;
				const first = rows[0];
				if (
					!first ||
					typeof first !== "object" ||
					!("acquired" in first) ||
					first.acquired !== true
				) {
					return null;
				}

				// Bounded so a large backlog cannot monopolize this cycle's hold on the
				// advisory lock; any remainder is picked up on the next cycle. Runs
				// unconditionally once the lock is held, independent of orphaned updates.
				const expiredNonces = await tx
					.delete(subscriptionTicketNonces)
					.where(
						inArray(
							subscriptionTicketNonces.nonce,
							tx
								.select({ nonce: subscriptionTicketNonces.nonce })
								.from(subscriptionTicketNonces)
								.where(lte(subscriptionTicketNonces.expiresAt, sql`now()`))
								.orderBy(subscriptionTicketNonces.expiresAt)
								.limit(SUBSCRIPTION_TICKET_NONCE_GC_BATCH_SIZE),
						),
					)
					.returning({ nonce: subscriptionTicketNonces.nonce });
				const noncesCleaned = expiredNonces.length;

				const now = new Date();
				const graceThreshold = new Date(now.getTime() - GC_LEASE_GRACE_MS);
				const staleThreshold = new Date(now.getTime() - GC_STALE_THRESHOLD_MS);
				const candidateStacks = await tx
					.selectDistinct({ stackId: updates.stackId })
					.from(updates)
					.where(
						or(
							and(eq(updates.status, "running"), lt(updates.leaseExpiresAt, graceThreshold)),
							and(
								inArray(updates.status, ["not started", "requested"]),
								lt(updates.createdAt, staleThreshold),
							),
						),
					)
					.orderBy(updates.stackId);

				if (candidateStacks.length === 0) {
					return { orphanCount: 0, expiredRunningCount: 0, noncesCleaned };
				}

				// Stack deletion and every update lifecycle writer acquire stack rows before
				// update rows. Lock the candidate stacks in deterministic order, then limit
				// both updates below to that locked set so GC follows the same ordering.
				const lockedStacks = await tx
					.select({ id: stacks.id })
					.from(stacks)
					.where(
						inArray(
							stacks.id,
							candidateStacks.map(({ stackId }) => stackId),
						),
					)
					.orderBy(stacks.id)
					.for("update");
				const lockedStackIds = lockedStacks.map(({ id }) => id);
				if (lockedStackIds.length === 0) {
					return { orphanCount: 0, expiredRunningCount: 0, noncesCleaned };
				}

				const expiredLeaseUpdates = await tx
					.update(updates)
					.set({
						status: "cancelled",
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(
						and(
							inArray(updates.stackId, lockedStackIds),
							eq(updates.status, "running"),
							lt(updates.leaseExpiresAt, graceThreshold),
						),
					)
					.returning({
						id: updates.id,
						stackId: updates.stackId,
						webhookContext: updates.webhookContext,
					});

				const staleUpdates = await tx
					.update(updates)
					.set({
						status: "cancelled",
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(
						and(
							inArray(updates.stackId, lockedStackIds),
							inArray(updates.status, ["not started", "requested"]),
							lt(updates.createdAt, staleThreshold),
						),
					)
					.returning({ id: updates.id, stackId: updates.stackId });

				const allOrphans = [...expiredLeaseUpdates, ...staleUpdates];
				if (allOrphans.length > 0) {
					const orphanIds = allOrphans.map((update) => update.id);

					// Only leases that were actually running had a start event; a never-started
					// update was never announced, so cancelling it announces nothing either.
					for (const update of expiredLeaseUpdates) {
						const context =
							update.webhookContext ?? (await loadUpdateWebhookContext(tx, update.stackId));
						if (!context) continue;
						await enqueueWebhookEvent(tx, {
							tenantId: context.tenantId,
							event: "update.cancelled",
							data: {
								org: context.org,
								project: context.project,
								stack: context.stack,
								updateId: update.id,
								status: "cancelled",
							},
						});
					}

					const affectedStackIds = [...new Set(allOrphans.map((update) => update.stackId))];
					await tx
						.update(stacks)
						.set({ activeUpdateId: null, updatedAt: sql`now()` })
						.where(
							and(inArray(stacks.id, affectedStackIds), inArray(stacks.activeUpdateId, orphanIds)),
						);
				}

				return {
					orphanCount: allOrphans.length,
					expiredRunningCount: expiredLeaseUpdates.length,
					noncesCleaned,
				};
			});

			if (!result) return;
			if (result.expiredRunningCount > 0) {
				activeUpdatesGauge().add(-result.expiredRunningCount);
			}
			gcOrphansCleanedCount().add(result.orphanCount);
			gcTicketNoncesCleanedCount().add(result.noncesCleaned);
		} finally {
			this.running = false;
		}
	}
}
