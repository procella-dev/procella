// @strata/updates — GC Worker for cleaning up stale/orphaned updates.

import type { Database } from "@strata/db";
import { stacks, updates } from "@strata/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { GC_ADVISORY_LOCK_ID, GC_INTERVAL_MS, GC_STALE_THRESHOLD_MS } from "./types.js";

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

	private async runCycle(): Promise<void> {
		if (this.running) return;
		this.running = true;

		try {
			// Try to acquire advisory lock (cluster-safe — only one GC runs at a time)
			const lockResult = await this.db.execute(
				sql`SELECT pg_try_advisory_lock(${GC_ADVISORY_LOCK_ID}) as acquired`,
			);

			const acquired = (lockResult[0] as { acquired?: boolean })?.acquired;
			if (!acquired) {
				return;
			}

			try {
				const now = new Date();

				// Find updates with expired leases
				const expiredLeaseUpdates = await this.db
					.select({ id: updates.id, stackId: updates.stackId })
					.from(updates)
					.where(and(eq(updates.status, "running"), lt(updates.leaseExpiresAt, now)));

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

				if (allOrphans.length > 0) {
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

					// Clear active update locks on affected stacks
					for (const stackId of affectedStackIds) {
						await this.db
							.update(stacks)
							.set({ activeUpdateId: null, updatedAt: sql`now()` })
							.where(and(eq(stacks.id, stackId), inArray(stacks.activeUpdateId, orphanIds)));
					}
				}
			} finally {
				// Always release the advisory lock
				await this.db.execute(sql`SELECT pg_advisory_unlock(${GC_ADVISORY_LOCK_ID})`);
			}
		} finally {
			this.running = false;
		}
	}
}
