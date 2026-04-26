// @procella/updates — GC Worker for cleaning up stale/orphaned updates.

import type { Database } from "@procella/db";
import { stacks, updates } from "@procella/db";
import { activeUpdatesGauge, gcCycleCount, gcOrphansCleanedCount } from "@procella/telemetry";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
	GC_ADVISORY_LOCK_ID,
	GC_INTERVAL_MS,
	GC_LEASE_GRACE_MS,
	GC_STALE_THRESHOLD_MS,
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
		await this.runCycle();
		this.timer = setInterval(() => this.runCycle(), this.interval);
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

	private async runCycle(): Promise<void> {
		if (this.running) return;
		this.running = true;
		gcCycleCount().add(1);

		try {
			// Try to acquire advisory lock (cluster-safe — only one GC runs at a time)
			const lockResult = await this.db.execute(
				sql`SELECT pg_try_advisory_lock(${GC_ADVISORY_LOCK_ID}) as acquired`,
			);

			const rows = "rows" in lockResult ? lockResult.rows : lockResult;
			const acquired = (rows[0] as { acquired?: boolean })?.acquired;
			if (!acquired) {
				return;
			}

			try {
				const now = new Date();

				// Find updates with expired leases (with 30s grace window for transient renewal delays)
				const graceThreshold = new Date(now.getTime() - GC_LEASE_GRACE_MS);
				const expiredLeaseUpdates = await this.db
					.select({ id: updates.id, stackId: updates.stackId })
					.from(updates)
					.where(and(eq(updates.status, "running"), lt(updates.leaseExpiresAt, graceThreshold)));

				// Find stale not-started/requested updates (older than threshold)
				const staleThreshold = new Date(now.getTime() - GC_STALE_THRESHOLD_MS);
				const staleUpdates = await this.db
					.select({ id: updates.id, stackId: updates.stackId })
					.from(updates)
					.where(
						and(
							inArray(updates.status, ["not started", "requested"]),
							lt(updates.createdAt, staleThreshold),
						),
					);

				const allOrphans = [...expiredLeaseUpdates, ...staleUpdates];
				const orphanCount = allOrphans.length;

				if (orphanCount > 0) {
					const orphanIds = allOrphans.map((u) => u.id);
					const affectedStackIds = [...new Set(allOrphans.map((u) => u.stackId))];

					// Cancel all orphaned updates
					await this.db
						.update(updates)
						.set({
							status: "cancelled",
							leaseToken: null,
							leaseExpiresAt: null,
							completedAt: sql`now()`,
							updatedAt: sql`now()`,
						})
						.where(inArray(updates.id, orphanIds));

					if (expiredLeaseUpdates.length > 0) {
						activeUpdatesGauge().add(-expiredLeaseUpdates.length);
					}

					for (const stackId of affectedStackIds) {
						await this.db
							.update(stacks)
							.set({ activeUpdateId: null, updatedAt: sql`now()` })
							.where(and(eq(stacks.id, stackId), inArray(stacks.activeUpdateId, orphanIds)));
					}
				}

				gcOrphansCleanedCount().add(orphanCount);
			} finally {
				// Always release the advisory lock
				await this.db.execute(sql`SELECT pg_advisory_unlock(${GC_ADVISORY_LOCK_ID})`);
			}
		} catch (err) {
			// GC is best-effort — log and retry on next interval. Never crash the server.
			console.error("[gc] cycle failed:", err);
		} finally {
			this.running = false;
		}
	}
}
