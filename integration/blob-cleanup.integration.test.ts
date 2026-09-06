import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blobCleanupQueue, type Database } from "@procella/db";
import { LocalBlobStorage, type BlobStorage } from "@procella/storage";
import { BlobCleanupWorker } from "@procella/updates";
import { eq, sql } from "drizzle-orm";
import { getTestDb, truncateTables } from "./setup.js";

let db: Database;
let blobDir: string;
let storage: LocalBlobStorage;

beforeAll(async () => {
	db = getTestDb();
	blobDir = await mkdtemp(path.join(tmpdir(), "procella-cleanup-blobs-"));
	storage = new LocalBlobStorage(blobDir);
});

afterEach(async () => {
	await truncateTables();
});

afterAll(async () => {
	await rm(blobDir, { recursive: true, force: true });
});

describe("BlobCleanupWorker — integration", () => {
	test("deletes only exact queued object keys", async () => {
		const queuedKey = "checkpoints/stack-a/update-a/1";
		const unrelatedKey = "checkpoints/stack-b/update-b/1";
		await storage.put(queuedKey, new TextEncoder().encode("sensitive"));
		await storage.put(unrelatedKey, new TextEncoder().encode("retained"));
		await db.insert(blobCleanupQueue).values({ blobKey: queuedKey });

		const worker = new BlobCleanupWorker({ db, storage });
		expect(await worker.runOnce()).toBe(1);

		expect(await storage.get(queuedKey)).toBeNull();
		const unrelated = await storage.get(unrelatedKey);
		expect(unrelated).not.toBeNull();
		if (!unrelated) throw new Error("unrelated blob missing");
		expect(new TextDecoder().decode(unrelated)).toBe("retained");
		expect(await db.select().from(blobCleanupQueue)).toHaveLength(0);
	});

	test("retains failed deletions for a restarted worker", async () => {
		const blobKey = "checkpoints/stack-a/update-a/failed";
		await storage.put(blobKey, new TextEncoder().encode("sensitive"));
		await db.insert(blobCleanupQueue).values({ blobKey });
		const failingStorage: BlobStorage = {
			get: (key) => storage.get(key),
			put: (key, data) => storage.put(key, data),
			delete: async () => {
				throw new Error(
					"request to https://user:pass@s3.example, token=abc123, authorization=Bearer secret",
				);
			},
			exists: (key) => storage.exists(key),
		};

		const firstWorker = new BlobCleanupWorker({ db, storage: failingStorage });
		expect(await firstWorker.runOnce()).toBe(0);
		const [failed] = await db.select().from(blobCleanupQueue).where(eq(blobCleanupQueue.blobKey, blobKey));
		expect(failed.attempts).toBe(1);
		expect(failed.claimedBy).toBeNull();
		expect(failed.lastError).toBe(
			"Error: request to https://[redacted]@s3.example, token=[redacted], authorization=[redacted]",
		);
		expect(await storage.exists(blobKey)).toBe(true);

		await db
			.update(blobCleanupQueue)
			.set({ availableAt: sql`now()` })
			.where(eq(blobCleanupQueue.blobKey, blobKey));
		const restartedWorker = new BlobCleanupWorker({ db, storage });
		expect(await restartedWorker.runOnce()).toBe(1);
		expect(await storage.exists(blobKey)).toBe(false);
		expect(await db.select().from(blobCleanupQueue)).toHaveLength(0);
	});

	test("reclaims an expired lease left by a stopped process", async () => {
		const blobKey = "checkpoints/stack-a/update-a/restart";
		await storage.put(blobKey, new TextEncoder().encode("sensitive"));
		await db.insert(blobCleanupQueue).values({
			blobKey,
			claimedBy: crypto.randomUUID(),
			claimedUntil: new Date(Date.now() - 1_000),
		});

		const restartedWorker = new BlobCleanupWorker({ db, storage });
		expect(await restartedWorker.runOnce()).toBe(1);
		expect(await storage.exists(blobKey)).toBe(false);
		expect(await db.select().from(blobCleanupQueue)).toHaveLength(0);
	});

	test("concurrent replicas claim each object once", async () => {
		const keys = Array.from({ length: 12 }, (_, index) => `checkpoints/stack/update/${index}`);
		await db.insert(blobCleanupQueue).values(keys.map((blobKey) => ({ blobKey })));
		const deletes: Record<string, number> = {};
		let concurrentDeletes = 0;
		let releaseDeletes: () => void = () => {};
		const deleteGate = new Promise<void>((resolve) => {
			releaseDeletes = resolve;
		});
		const countingStorage: BlobStorage = {
			get: async () => null,
			put: async () => {},
			delete: async (key) => {
				concurrentDeletes += 1;
				if (concurrentDeletes === 2) releaseDeletes();
				await deleteGate;
				deletes[key] = (deletes[key] ?? 0) + 1;
			},
			exists: async () => false,
		};
		const firstWorker = new BlobCleanupWorker({ db, storage: countingStorage });
		const secondWorker = new BlobCleanupWorker({ db, storage: countingStorage });

		const counts = await Promise.all([firstWorker.runOnce(), secondWorker.runOnce()]);
		expect(counts[0] + counts[1]).toBe(keys.length);
		expect(await db.select().from(blobCleanupQueue)).toHaveLength(0);
		expect(Object.entries(deletes).sort()).toEqual(
			keys.map((key): [string, number] => [key, 1]).sort(),
		);
	});
});
