// Regression coverage for M4c — dashboard subscriptions must not scale
// PostgreSQL connections with subscriber count, must reject past a bounded
// cap, and must release everything on disconnect and on listener failure.
//
// Run against real PostgreSQL: bun run test:integration

import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AesCryptoService } from "@procella/crypto";
import type { Database } from "@procella/db";
import { PostgresStacksService, type StackInfo } from "@procella/stacks";
import { LocalBlobStorage } from "@procella/storage";
import { PostgresUpdatesService } from "@procella/updates";
import { TRPCError } from "@trpc/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	NOTIFY_APPLICATION_NAME,
	PostgresNotificationHub,
} from "../packages/api/src/notifications.js";
import { updatesRouter } from "../packages/api/src/router/updates.js";
import type { TRPCContext } from "../packages/api/src/trpc.js";
import { getTestDb, getTestDbUrl, truncateTables } from "./setup.js";

const TENANT = "tenant-1";
const ORG = "org-1";
const PROJECT = "test-project";

let db: Database;
let stacksService: PostgresStacksService;
let updatesService: PostgresUpdatesService;
let blobDir: string;
let stats: SQL;
const hubs: PostgresNotificationHub[] = [];

beforeAll(async () => {
	db = getTestDb();
	stacksService = new PostgresStacksService({ db });
	blobDir = await mkdtemp(path.join(tmpdir(), "procella-subs-blobs-"));
	updatesService = new PostgresUpdatesService({
		db,
		storage: new LocalBlobStorage(blobDir),
		crypto: new AesCryptoService("a".repeat(64)),
	});
	stats = new SQL({ url: getTestDbUrl(), max: 1 });
});

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	await truncateTables();
});

afterAll(async () => {
	await stats?.close();
	await rm(blobDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================================
// Helpers
// ============================================================================

function makeHub(maxConcurrent?: number): PostgresNotificationHub {
	const hub = new PostgresNotificationHub({
		connectionString: getTestDbUrl(),
		maxConcurrent,
	});
	hubs.push(hub);
	return hub;
}

function makeContext(hub: PostgresNotificationHub): TRPCContext {
	return {
		caller: {
			tenantId: TENANT,
			orgSlug: ORG,
			userId: "user-1",
			login: "alice",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: async () => null,
		db,
		notifications: hub,
		stacks: stacksService,
		audit: {} as never,
		updates: updatesService,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
	} satisfies Partial<TRPCContext> as TRPCContext;
}

/** Backend connections parked on LISTEN — one per subscriber before M4c. */
async function listenerConnections(): Promise<number> {
	const rows = await stats`
		SELECT count(*)::int AS count
		FROM pg_stat_activity
		WHERE datname = current_database()
		  AND query ILIKE 'LISTEN %'`;
	return rows[0]?.count ?? 0;
}

async function notifyConnectionPids(): Promise<number[]> {
	const rows = await stats`
		SELECT pid
		FROM pg_stat_activity
		WHERE datname = current_database()
		  AND application_name = ${NOTIFY_APPLICATION_NAME}`;
	return rows.map((row: { pid: number }) => row.pid);
}

/**
 * Backend teardown is only observable by polling `pg_stat_activity`; PostgreSQL
 * exposes no event to await, so this is the documented real-timer exception.
 */
async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function seedUpdate(stack: StackInfo): Promise<string> {
	const created = await updatesService.createUpdate(stack.id, "update");
	return created.updateID;
}

async function postEvent(updateId: string, sequence: number): Promise<void> {
	await updatesService.postEvents(updateId, {
		events: [
			{
				sequence,
				timestamp: Date.now(),
				diagnosticEvent: { message: `event-${sequence}`, color: "always", severity: "info" },
			},
		],
	});
}

type EventStream = AsyncGenerator<unknown, void, undefined>;

async function openEvents(
	ctx: TRPCContext,
	stack: StackInfo,
	updateId: string,
	lastEventId?: number,
): Promise<EventStream> {
	const iterator = await updatesRouter.createCaller(ctx).onEvents({
		org: ORG,
		project: PROJECT,
		stack: stack.stackName,
		updateId,
		lastEventId,
	});
	return iterator[Symbol.asyncIterator]() as EventStream;
}

async function openStackActivity(ctx: TRPCContext, stack: StackInfo): Promise<EventStream> {
	const iterator = await updatesRouter
		.createCaller(ctx)
		.onStackActivity({ org: ORG, project: PROJECT, stack: stack.stackName });
	return iterator[Symbol.asyncIterator]() as EventStream;
}

/** tracked() envelopes are [id, data, sentinel] tuples on the server side. */
function envelopeId(value: unknown): string {
	if (!Array.isArray(value) || typeof value[0] !== "string") {
		throw new Error(`Expected a tracked envelope, got ${JSON.stringify(value)}`);
	}
	return value[0];
}

// ============================================================================
// Tests
// ============================================================================

describe("dashboard subscriptions — integration", () => {
	test("many concurrent subscribers share one listener connection per channel", async () => {
		const hub = makeHub();
		const ctx = makeContext(hub);
		const stack = await stacksService.createStack(TENANT, ORG, PROJECT, "shared-listener");

		const updateId = await seedUpdate(stack);
		await updatesService.startUpdate(updateId, {});
		await postEvent(updateId, 1);

		expect(await listenerConnections()).toBe(0);

		const streams: EventStream[] = [];
		for (let i = 0; i < 25; i++) streams.push(await openEvents(ctx, stack, updateId));
		const activity: EventStream[] = [];
		for (let i = 0; i < 5; i++) activity.push(await openStackActivity(ctx, stack));

		// Draining the replayed event proves every event subscriber is listening.
		const firsts = await Promise.all(streams.map((stream) => stream.next()));
		expect(firsts.map((r) => envelopeId(r.value))).toEqual(Array(25).fill("1"));

		// Stack-activity subscribers only emit on NOTIFY, so wait until they are
		// all listening before producing the change they must observe.
		const activityFirsts = activity.map((stream) => stream.next());
		await waitFor(async () => hub.activeSubscriptions === 30, "all subscriptions to open");
		await updatesService.completeUpdate(updateId, { status: "succeeded" });
		const activityResults = await Promise.all(activityFirsts);
		expect(activityResults.map((r) => envelopeId(r.value))).toEqual(Array(5).fill(updateId));

		expect(hub.activeSubscriptions).toBe(30);
		expect(hub.openConnections).toBe(2);
		expect(await listenerConnections()).toBe(2);

		await Promise.all([...streams, ...activity].map((stream) => stream.return()));
		expect(hub.activeSubscriptions).toBe(0);
		expect(hub.openConnections).toBe(0);
		await waitFor(async () => (await listenerConnections()) === 0, "listener connections to drain");
	});

	test("rejects subscriptions past the configured cap", async () => {
		const hub = makeHub(2);
		const ctx = makeContext(hub);
		const stack = await stacksService.createStack(TENANT, ORG, PROJECT, "capped");
		const updateId = await seedUpdate(stack);
		await postEvent(updateId, 1);

		const first = await openEvents(ctx, stack, updateId);
		const second = await openEvents(ctx, stack, updateId);
		await Promise.all([first.next(), second.next()]);

		const third = await openEvents(ctx, stack, updateId);
		const error = await third.next().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe("TOO_MANY_REQUESTS");
		expect(await listenerConnections()).toBe(1);

		// A released slot is immediately reusable.
		await first.return();
		const fourth = await openEvents(ctx, stack, updateId);
		expect(envelopeId((await fourth.next()).value)).toBe("1");

		await Promise.all([second.return(), fourth.return()]);
	});

	test("resumes after lastEventId and streams later events in order", async () => {
		const hub = makeHub();
		const ctx = makeContext(hub);
		const stack = await stacksService.createStack(TENANT, ORG, PROJECT, "resumable");
		const updateId = await seedUpdate(stack);
		await postEvent(updateId, 1);
		await postEvent(updateId, 2);
		await postEvent(updateId, 3);

		const stream = await openEvents(ctx, stack, updateId, 2);
		expect(envelopeId((await stream.next()).value)).toBe("3");

		await postEvent(updateId, 4);
		await postEvent(updateId, 5);
		const fourth = envelopeId((await stream.next()).value);
		const fifth = envelopeId((await stream.next()).value);
		expect([fourth, fifth]).toEqual(["4", "5"]);

		await stream.return();
		await waitFor(async () => (await listenerConnections()) === 0, "listener connections to drain");
	});

	test("fails open subscriptions and releases the connection when the listener drops", async () => {
		const hub = makeHub();
		const ctx = makeContext(hub);
		const stack = await stacksService.createStack(TENANT, ORG, PROJECT, "listener-drop");
		const updateId = await seedUpdate(stack);
		await postEvent(updateId, 1);

		const stream = await openEvents(ctx, stack, updateId);
		expect(envelopeId((await stream.next()).value)).toBe("1");

		const pending = stream.next();
		const pids = await notifyConnectionPids();
		expect(pids).toHaveLength(1);
		await stats`SELECT pg_terminate_backend(${pids[0]})`;

		await expect(pending).rejects.toThrow();
		expect(hub.openConnections).toBe(0);
		await waitFor(async () => (await listenerConnections()) === 0, "listener connections to drain");

		// The hub recovers: the next subscriber opens a fresh listener connection.
		await stream.return();
		const revived = await openEvents(ctx, stack, updateId);
		expect(envelopeId((await revived.next()).value)).toBe("1");
		expect(hub.openConnections).toBe(1);
		await revived.return();
	});

	test("hub shutdown ends live subscriptions and closes every connection", async () => {
		const hub = makeHub();
		const ctx = makeContext(hub);
		const stack = await stacksService.createStack(TENANT, ORG, PROJECT, "shutdown");
		const updateId = await seedUpdate(stack);
		await postEvent(updateId, 1);

		const stream = await openEvents(ctx, stack, updateId);
		expect(envelopeId((await stream.next()).value)).toBe("1");
		const pending = stream.next();

		await hub.close();

		expect((await pending).done).toBe(true);
		expect(hub.openConnections).toBe(0);
		await waitFor(async () => (await listenerConnections()) === 0, "listener connections to drain");
	});
});
