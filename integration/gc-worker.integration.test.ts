import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "@procella/db";
import { subscriptionTicketNonces, updates } from "@procella/db";
import { PostgresStacksService, type StackInfo } from "@procella/stacks";
import { GCWorker, SUBSCRIPTION_TICKET_NONCE_GC_BATCH_SIZE } from "@procella/updates";
import { eq, sql } from "drizzle-orm";
import { getTestDb, getTestDbUrl, truncateTables } from "./setup.js";

let db: Database;
let stacksService: PostgresStacksService;

beforeAll(() => {
	db = getTestDb();
	stacksService = new PostgresStacksService({ db });
});

afterEach(async () => {
	await truncateTables();
});

async function seedStack(): Promise<StackInfo> {
	return stacksService.createStack("tenant-1", "org-1", "proj-1", `stack-${Date.now()}`);
}

/** Insert an update directly with a specific status and lease expiry for GC testing. */
async function insertStaleUpdate(
	stackId: string,
	status: string,
	leaseExpiresAt: Date | null,
	createdAt?: Date,
): Promise<string> {
	const id = crypto.randomUUID();
	await db.execute(
		sql`INSERT INTO updates (id, stack_id, kind, status, version, lease_expires_at, created_at, updated_at)
		    VALUES (${id}, ${stackId}, 'update', ${status}, 1, ${leaseExpiresAt}, ${createdAt ?? new Date()}, ${new Date()})`,
	);
	return id;
}

describe("GCWorker — integration", () => {
	// ========================================================================
	// Advisory lock
	// ========================================================================

	describe("advisory lock", () => {
		test("runOnce acquires and releases lock successfully", async () => {
			const worker = new GCWorker({ db, interval: 999_999 });
			// Should not throw — lock should be free
			await worker.runOnce();
		});

		test("concurrent GC workers — only one acquires lock", async () => {
			// Hold the advisory lock on a separate connection
			const { SQL } = require("bun") as typeof import("bun");
			const lockConn = new SQL({ url: getTestDbUrl() });
			const GC_LOCK_ID = 93_874_835_275_587n;
			await lockConn.unsafe(`SELECT pg_advisory_lock(${GC_LOCK_ID})`);

			try {
				const worker = new GCWorker({ db, interval: 999_999 });
				// GC should silently skip (lock held by lockConn)
				await worker.runOnce();
				// No error = correct behavior (lock acquisition returned false, GC skipped)
			} finally {
				await lockConn.unsafe(`SELECT pg_advisory_unlock(${GC_LOCK_ID})`);
				await lockConn.close();
			}
		});
	});

	// ========================================================================
	// Orphan cleanup
	// ========================================================================

	describe("orphan cleanup", () => {
		test("cancels updates with expired leases", async () => {
			const stack = await seedStack();
			const pastDate = new Date(Date.now() - 60_000); // 1 minute ago
			const updateId = await insertStaleUpdate(stack.id, "running", pastDate);

			// Set activeUpdateId on stack
			await db.execute(
				sql`UPDATE stacks SET active_update_id = ${updateId} WHERE id = ${stack.id}`,
			);

			const worker = new GCWorker({ db, interval: 999_999 });
			await worker.runOnce();

			// Update should now be cancelled
			const [row] = await db
				.select({ status: updates.status })
				.from(updates)
				.where(eq(updates.id, updateId));
			expect(row.status).toBe("cancelled");
		});

		test("cancels stale not-started updates older than threshold", async () => {
			const stack = await seedStack();
			const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
			const updateId = await insertStaleUpdate(stack.id, "not started", null, oldDate);

			const worker = new GCWorker({ db, interval: 999_999 });
			await worker.runOnce();

			const [row] = await db
				.select({ status: updates.status })
				.from(updates)
				.where(eq(updates.id, updateId));
			expect(row.status).toBe("cancelled");
		});

		test("does NOT cancel running updates with valid leases", async () => {
			const stack = await seedStack();
			const futureDate = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
			const updateId = await insertStaleUpdate(stack.id, "running", futureDate);

			const worker = new GCWorker({ db, interval: 999_999 });
			await worker.runOnce();

			const [row] = await db
				.select({ status: updates.status })
				.from(updates)
				.where(eq(updates.id, updateId));
			expect(row.status).toBe("running");
		});

		test("does NOT cancel recent not-started updates", async () => {
			const stack = await seedStack();
			const updateId = await insertStaleUpdate(stack.id, "not started", null, new Date());

			const worker = new GCWorker({ db, interval: 999_999 });
			await worker.runOnce();

			const [row] = await db
				.select({ status: updates.status })
				.from(updates)
				.where(eq(updates.id, updateId));
			expect(row.status).toBe("not started");
		});

		test("clears activeUpdateId on stack after cancelling orphan", async () => {
			const stack = await seedStack();
			const pastDate = new Date(Date.now() - 60_000);
			const updateId = await insertStaleUpdate(stack.id, "running", pastDate);

			await db.execute(
				sql`UPDATE stacks SET active_update_id = ${updateId} WHERE id = ${stack.id}`,
			);

			const worker = new GCWorker({ db, interval: 999_999 });
			await worker.runOnce();

			const [stackRow] = await db.execute(
				sql`SELECT active_update_id FROM stacks WHERE id = ${stack.id}`,
			);
			const row = stackRow as { active_update_id: string | null };
			expect(row.active_update_id).toBeNull();
		});
	});

	// ========================================================================
	// Subscription ticket nonce cleanup
	// ========================================================================

	describe("subscription ticket nonce cleanup", () => {
		test("bounds cleanup to SUBSCRIPTION_TICKET_NONCE_GC_BATCH_SIZE per cycle and retains live nonces", async () => {
			const backlogSize = SUBSCRIPTION_TICKET_NONCE_GC_BATCH_SIZE + 100;
			const expiredAt = new Date(Date.now() - 1_000);
			const liveNonce = crypto.randomUUID();
			await db.insert(subscriptionTicketNonces).values([
				...Array.from({ length: backlogSize }, () => ({
					nonce: crypto.randomUUID(),
					expiresAt: expiredAt,
				})),
				{ nonce: liveNonce, expiresAt: new Date(Date.now() + 60_000) },
			]);

			const worker = new GCWorker({ db, interval: 60_000 });

			await worker.runOnce();
			const remainingAfterFirstCycle = await db.select().from(subscriptionTicketNonces);
			// One cycle removes at most the batch size, leaving the rest (plus the live
			// nonce) for the next cycle — a single backlog cannot monopolize the lock.
			expect(remainingAfterFirstCycle.length).toBe(
				backlogSize + 1 - SUBSCRIPTION_TICKET_NONCE_GC_BATCH_SIZE,
			);

			await worker.runOnce();
			const remainingAfterSecondCycle = await db.select().from(subscriptionTicketNonces);
			// The rest of the backlog is cleaned up on the next cycle; the live nonce
			// (not yet expired) is untouched throughout.
			expect(remainingAfterSecondCycle).toEqual([expect.objectContaining({ nonce: liveNonce })]);
		});

		test("concurrent replicas racing the same GC cycle converge without errors or double work", async () => {
			const expiredNonces = Array.from({ length: 5 }, () => crypto.randomUUID());
			const liveNonce = crypto.randomUUID();
			await db.insert(subscriptionTicketNonces).values([
				...expiredNonces.map((nonce) => ({ nonce, expiresAt: new Date(Date.now() - 1_000) })),
				{ nonce: liveNonce, expiresAt: new Date(Date.now() + 60_000) },
			]);

			// Three GCWorker instances model three replicas racing the same advisory
			// lock (pg_try_advisory_xact_lock is non-blocking, so at most one wins per
			// cycle); the others return immediately having done no cleanup work.
			const replicas = Array.from({ length: 3 }, () => new GCWorker({ db, interval: 60_000 }));
			await Promise.all(replicas.map((replica) => replica.runOnce()));

			for (const nonce of expiredNonces) {
				expect(
					await db
						.select()
						.from(subscriptionTicketNonces)
						.where(eq(subscriptionTicketNonces.nonce, nonce)),
				).toHaveLength(0);
			}
			expect(
				await db
					.select()
					.from(subscriptionTicketNonces)
					.where(eq(subscriptionTicketNonces.nonce, liveNonce)),
			).toHaveLength(1);
		});
	});
});
