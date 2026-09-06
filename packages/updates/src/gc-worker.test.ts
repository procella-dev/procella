import { describe, expect, jest, test } from "bun:test";
import { GCWorker } from "./gc-worker.js";

describe("@procella/updates GCWorker", () => {
	// ========================================================================
	// Resilience
	// ========================================================================

	describe("resilience", () => {
		test("runOnce propagates database failures", async () => {
			const failDb = {
				transaction: () => Promise.reject(new Error("connection refused")),
			};
			const worker = new GCWorker({ db: failDb as never, interval: 60_000 });

			await expect(worker.runOnce()).rejects.toThrow("connection refused");
		});

		test("interval mode retries after a database failure", async () => {
			jest.useFakeTimers();
			let attempts = 0;
			let retryObserved!: () => void;
			const retried = new Promise<void>((resolve) => {
				retryObserved = resolve;
			});
			const retryDb = {
				transaction: async (callback: (tx: unknown) => unknown) => {
					attempts += 1;
					if (attempts === 1) throw new Error("connection refused");
					const result = await callback({
						execute: async () => ({ rows: [{ acquired: false }] }),
					});
					retryObserved();
					return result;
				},
			};
			const worker = new GCWorker({ db: retryDb as never, interval: 1 });

			try {
				await worker.start();
				expect(attempts).toBe(1);

				jest.advanceTimersByTime(1);
				await retried;
				await Promise.resolve();

				expect(attempts).toBe(2);
			} finally {
				jest.useRealTimers();
				await worker.stop();
			}
		});
	});

	// ========================================================================
	// M8: Grace window
	// ========================================================================

	describe("M8: grace window excludes recently-expired leases", () => {
		test("functional: runOnce completes the GC cycle without throwing (PR #149 review — invoke the actual cycle, not just constants)", async () => {
			const mockDb: Record<string, unknown> = {};
			Object.assign(mockDb, {
				execute: async () => ({ rows: [{ acquired: true }] }),
				selectDistinct: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => Promise.resolve([{ stackId: "stack-1" }]),
						}),
					}),
				}),
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => ({
								for: () => Promise.resolve([{ id: "stack-1" }]),
							}),
						}),
					}),
				}),
				update: () => ({
					set: () => ({
						where: () => ({ returning: () => [] }),
					}),
				}),
				transaction: (callback: (tx: unknown) => unknown) => callback(mockDb),
			});

			const worker = new GCWorker({ db: mockDb as never, interval: 60_000 });
			await expect(worker.runOnce()).resolves.toBeUndefined();
		});
	});
});
