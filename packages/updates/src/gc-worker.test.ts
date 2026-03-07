import { describe, expect, test } from "bun:test";
import { GCWorker } from "./gc-worker.js";
import { GC_ADVISORY_LOCK_ID, GC_INTERVAL_MS, GC_STALE_THRESHOLD_MS } from "./types.js";

describe("@strata/updates GCWorker", () => {
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
});
