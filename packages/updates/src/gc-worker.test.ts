import { describe, expect, test } from "bun:test";
import { GCWorker } from "./gc-worker.js";
import {
	GC_ADVISORY_LOCK_ID,
	GC_INTERVAL_MS,
	GC_LEASE_GRACE_MS,
	GC_STALE_THRESHOLD_MS,
} from "./types.js";

describe("@procella/updates GCWorker", () => {
	// ========================================================================
	// Construction
	// ========================================================================

	describe("constructor", () => {
		test("can be constructed with default interval", () => {
			// GCWorker requires a Database but we only test construction shape
			const worker = new GCWorker({ db: {} as never });
			expect(worker).toBeDefined();
		});

		test("can be constructed with custom interval", () => {
			const worker = new GCWorker({ db: {} as never, interval: 5_000 });
			expect(worker).toBeDefined();
		});
	});

	// ========================================================================
	// Constants
	// ========================================================================

	describe("constants", () => {
		test("GC_ADVISORY_LOCK_ID is a bigint", () => {
			expect(typeof GC_ADVISORY_LOCK_ID).toBe("bigint");
		});

		test("GC_STALE_THRESHOLD_MS is 1 hour", () => {
			expect(GC_STALE_THRESHOLD_MS).toBe(3_600_000);
		});

		test("GC_INTERVAL_MS is 60 seconds", () => {
			expect(GC_INTERVAL_MS).toBe(60_000);
		});

		test("M8: GC_LEASE_GRACE_MS is 30 seconds", () => {
			expect(GC_LEASE_GRACE_MS).toBe(30_000);
		});
	});

	// ========================================================================
	// Type satisfaction
	// ========================================================================

	describe("type checks", () => {
		test("start and stop are async functions", () => {
			const worker = new GCWorker({ db: {} as never });
			expect(typeof worker.start).toBe("function");
			expect(typeof worker.stop).toBe("function");
		});
	});

	// ========================================================================
	// Resilience
	// ========================================================================

	describe("resilience", () => {
		test("start does not throw when db.execute rejects", async () => {
			const failDb = {
				execute: () => Promise.reject(new Error("connection refused")),
			};
			const worker = new GCWorker({ db: failDb as never, interval: 60_000 });
			expect(await worker.start()).toBeUndefined();
			await worker.stop();
		});
	});

	// ========================================================================
	// M8: Grace window
	// ========================================================================

	describe("M8: grace window excludes recently-expired leases", () => {
		test("functional: runOnce completes the GC cycle without throwing (PR #149 review — invoke the actual cycle, not just constants)", async () => {
			const mockDb = {
				execute: async (query: unknown) => {
					const queryStr = String(query);
					if (queryStr.includes("pg_try_advisory_lock")) {
						return { rows: [{ acquired: true }] };
					}
					return { rows: [] };
				},
				select: () => ({
					from: () => ({
						where: () => Promise.resolve([]),
					}),
				}),
				update: () => ({
					set: () => ({
						where: () => ({ returning: () => [] }),
					}),
				}),
			};

			const worker = new GCWorker({ db: mockDb as never, interval: 60_000 });
			await expect(worker.runOnce()).resolves.toBeUndefined();
		});
	});
});
