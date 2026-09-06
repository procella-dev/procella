import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AuthService } from "@procella/auth";
import { subscriptionTicketNonces, type Database } from "@procella/db";
import type { Caller, SubscriptionTicketScope } from "@procella/types";
import { eq, sql } from "drizzle-orm";
import {
	createSubscriptionTicketService,
	PostgresSubscriptionTicketStore,
} from "../apps/server/src/subscription-tickets.js";
import { authenticateTrpcCaller } from "../apps/server/src/routes/trpc-auth.js";
import { getTestDb, truncateTables } from "./setup.js";

const SIGNING_KEY = "ticket-signing-key-ticket-signing-key";
const caller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "my-org",
	userId: "user-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};
const scope: SubscriptionTicketScope = {
	procedure: "updates.onEvents",
	resource: {
		org: "my-org",
		project: "my-project",
		stack: "dev",
		updateId: "update-1",
	},
};

const auth = {
	authenticate: async () => {
		throw new Error("Header authentication is not expected");
	},
	authenticateUpdateToken: async () => ({ updateId: "update-1", stackId: "stack-1" }),
	resolveUserDisplayName: async () => null,
} satisfies AuthService;

function subscriptionRequest(): Request {
	const input = encodeURIComponent(JSON.stringify({ json: scope.resource }));
	return new Request(`https://procella.dev/trpc/${scope.procedure}?input=${input}`, {
		method: "GET",
	});
}

let db: Database;

beforeAll(() => {
	db = getTestDb();
});

afterEach(async () => {
	await truncateTables();
});

describe("subscription ticket replay prevention", () => {
	test("accepts exactly one of two concurrent requests across replicas", async () => {
		const replicas = Array.from({ length: 3 }, () =>
			createSubscriptionTicketService(SIGNING_KEY, new PostgresSubscriptionTicketStore(db)),
		);
		const ticket = await replicas[0].issueTicket(caller, scope);

		const results = await Promise.all([
			authenticateTrpcCaller(subscriptionRequest(), ticket, {
				auth,
				verifySubscriptionTicket: replicas[1].verifyTicket,
			}),
			authenticateTrpcCaller(subscriptionRequest(), ticket, {
				auth,
				verifySubscriptionTicket: replicas[2].verifyTicket,
			}),
		]);

		expect(results.filter((result) => !result.invalidTicket)).toEqual([
			{ caller, invalidTicket: false },
		]);
		expect(results.filter((result) => result.invalidTicket)).toEqual([
			{ caller: null, invalidTicket: true },
		]);
		expect(await db.select().from(subscriptionTicketNonces)).toHaveLength(1);
	});

	test("rejects consumption at or after database expiry", async () => {
		const store = new PostgresSubscriptionTicketStore(db);

		expect(await store.consume(crypto.randomUUID(), new Date(Date.now() - 1_000))).toBeFalse();
		expect(await db.select().from(subscriptionTicketNonces)).toHaveLength(0);
	});

	test("issuance succeeds and never touches nonce cleanup, even with an expired backlog present", async () => {
		// Cleanup now lives solely in GCWorker's bounded GC cycle (see
		// integration/gc-worker.integration.test.ts), so ticket issuance cannot be
		// blocked, slowed, or failed by nonce cleanup latency or errors.
		const expiredNonce = crypto.randomUUID();
		await db
			.insert(subscriptionTicketNonces)
			.values([{ nonce: expiredNonce, expiresAt: new Date(Date.now() - 1_000) }]);
		const service = createSubscriptionTicketService(
			SIGNING_KEY,
			new PostgresSubscriptionTicketStore(db),
		);

		await expect(service.issueTicket(caller, scope)).resolves.toBeString();

		expect(
			await db
				.select()
				.from(subscriptionTicketNonces)
				.where(eq(subscriptionTicketNonces.nonce, expiredNonce)),
		).toHaveLength(1);
	});

	test("rejects a nonce whose row was recreated after real time already passed expiry inside a long-running transaction", async () => {
		// PostgreSQL's `now()` is the transaction's snapshot timestamp: it stays frozen
		// at BEGIN for the whole transaction, including nested savepoints. consume()'s
		// internal transaction is a savepoint when run inside this outer transaction,
		// so it inherits this outer BEGIN's frozen `now()` even though real time (and
		// clock_timestamp()) has since moved past the nonce's expiry. A guard built on
		// `now()` would incorrectly treat the nonce as not-yet-expired here; the fixed
		// guard uses clock_timestamp(), which always reflects real elapsed time.
		const consumed = await db.transaction(async (tx) => {
			const nonce = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 50);

			// Force real wall-clock time (and clock_timestamp()) forward past expiresAt
			// while this transaction's own `now()` remains pinned at its BEGIN, which
			// happened before expiresAt.
			await tx.execute(sql`SELECT pg_sleep(0.3)`);

			const store = new PostgresSubscriptionTicketStore(tx as unknown as Database);
			return await store.consume(nonce, expiresAt);
		});

		expect(consumed).toBeFalse();
	});
});
