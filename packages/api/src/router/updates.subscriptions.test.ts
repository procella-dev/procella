// Regression coverage for M4c — dashboard subscriptions multiplex over a
// shared notification hub instead of opening a PostgreSQL connection each.

import { describe, expect, test } from "bun:test";
import type { StackInfo } from "@procella/stacks";
import { isTrackedEnvelope, TRPCError } from "@trpc/server";
import type { NotificationHub, NotificationStream, NotifyChannel } from "../notifications.js";
import type { TRPCContext } from "../trpc.js";
import { updatesRouter } from "./updates.js";

const UPDATE_ID = "11111111-2222-4333-8444-555555555555";

const stackInfo: StackInfo = {
	id: "stack-1",
	projectId: "project-1",
	tenantId: "tenant-1",
	orgName: "my-org",
	projectName: "my-project",
	stackName: "dev",
	tags: {},
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// ============================================================================
// Doubles
// ============================================================================

class TestStream implements NotificationStream {
	closeCount = 0;
	waitCount = 0;
	private waiter: PromiseWithResolvers<boolean> | null = null;
	private buffered: { kind: "notify" | "stop" } | { kind: "fail"; error: Error } | null = null;

	wait(): Promise<boolean> {
		this.waitCount++;
		const buffered = this.buffered;
		this.buffered = null;
		if (buffered?.kind === "notify") return Promise.resolve(true);
		if (buffered?.kind === "stop") return Promise.resolve(false);
		if (buffered?.kind === "fail") return Promise.reject(buffered.error);
		this.waiter = Promise.withResolvers<boolean>();
		return this.waiter.promise;
	}

	close(): void {
		this.closeCount++;
	}

	notify(): void {
		if (this.waiter) {
			this.waiter.resolve(true);
			this.waiter = null;
		} else this.buffered = { kind: "notify" };
	}

	stop(): void {
		if (this.waiter) {
			this.waiter.resolve(false);
			this.waiter = null;
		} else this.buffered = { kind: "stop" };
	}

	fail(error: Error): void {
		if (this.waiter) {
			this.waiter.reject(error);
			this.waiter = null;
		} else this.buffered = { kind: "fail", error };
	}
}

class TestHub implements NotificationHub {
	readonly maxConcurrent = 10;
	activeSubscriptions = 0;
	openConnections = 0;
	readonly subscribed: Array<{ channel: NotifyChannel; key: string }> = [];
	readonly streams: TestStream[] = [];
	rejectWith: TRPCError | null = null;
	/** Holds `subscribe()` open so a test can disconnect mid-setup. */
	setupGate: Promise<void> | null = null;

	async subscribe(
		channel: NotifyChannel,
		key: string,
		signal: AbortSignal,
	): Promise<NotificationStream> {
		if (this.rejectWith) throw this.rejectWith;
		if (this.setupGate) await this.setupGate;
		if (signal.aborted) {
			throw new TRPCError({
				code: "CLIENT_CLOSED_REQUEST",
				message: "Subscription aborted before the listener was ready",
			});
		}
		this.subscribed.push({ channel, key });
		const stream = new TestStream();
		this.streams.push(stream);
		return stream;
	}

	async close(): Promise<void> {}

	get stream(): TestStream {
		const stream = this.streams[0];
		if (!stream) throw new Error("no subscription was opened");
		return stream;
	}
}

/** Drizzle-shaped query builder that hands out scripted result sets in order. */
function scriptedDb(script: Array<unknown[] | Error>) {
	let index = 0;
	const chain: Record<string, unknown> = {};
	const step = () => chain;
	chain.select = step;
	chain.from = step;
	chain.where = step;
	chain.orderBy = step;
	chain.limit = step;
	// biome-ignore lint/suspicious/noThenProperty: drizzle query builders are thenable; the fake must be awaitable at any chain position
	chain.then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
		const next = script[index++] ?? [];
		if (next instanceof Error) reject(next);
		else resolve(next);
	};
	return chain as unknown as TRPCContext["db"];
}

/**
 * Let the subscription generator run until it has opened its subscription.
 * Microtask-only, so tests stay deterministic without timers.
 */
async function openedStream(hub: TestHub): Promise<TestStream> {
	for (let i = 0; i < 50 && hub.streams.length === 0; i++) await Promise.resolve();
	return hub.stream;
}

/** tracked() yields [id, data, sentinel] envelopes on the server side. */
function envelope(value: unknown): { id: string; data: unknown } {
	if (!isTrackedEnvelope(value)) {
		throw new Error(`Expected a tracked envelope, got ${JSON.stringify(value)}`);
	}
	const [id, data] = value;
	return { id, data };
}

function makeContext(
	script: Array<unknown[] | Error>,
	overrides?: { hub?: TestHub; getStack?: TRPCContext["stacks"]["getStack"] },
) {
	const hub = overrides?.hub ?? new TestHub();
	const db = scriptedDb(script);
	const ctx = {
		caller: {
			tenantId: "tenant-1",
			orgSlug: "my-org",
			userId: "user-1",
			login: "alice",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: async () => null,
		db,
		notifications: hub,
		stacks: {
			getStack: overrides?.getStack ?? (async () => stackInfo),
		} as unknown as TRPCContext["stacks"],
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
	} as unknown as TRPCContext;
	return { ctx, hub };
}

const eventRow = (sequence: number) => ({
	sequence,
	fields: { message: `event-${sequence}` },
});

// ============================================================================
// updates.onEvents
// ============================================================================

describe("updates.onEvents", () => {
	test("subscribes to the shared update_events channel keyed by update ID", async () => {
		const { ctx, hub } = makeContext([[{ id: UPDATE_ID }], []]);
		const iterator = await updatesRouter
			.createCaller(ctx)
			.onEvents({ org: "my-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		const first = iterator[Symbol.asyncIterator]().next();
		const stream = await openedStream(hub);

		expect(hub.subscribed).toEqual([{ channel: "update_events", key: UPDATE_ID }]);
		stream.stop();
		expect((await first).done).toBe(true);
		expect(stream.closeCount).toBe(1);
	});

	test("replays only events after lastEventId, in sequence order", async () => {
		const { ctx, hub } = makeContext([
			[{ id: UPDATE_ID }],
			[eventRow(3), eventRow(4)],
			[eventRow(5)],
		]);
		const iterator = await updatesRouter.createCaller(ctx).onEvents({
			org: "my-org",
			project: "my-project",
			stack: "dev",
			updateId: UPDATE_ID,
			lastEventId: 2,
		});

		const received: unknown[] = [];
		for await (const event of iterator) {
			received.push(event);
			if (received.length === 2) hub.stream.notify();
			if (received.length === 3) break;
		}

		// Sequence 1 and 2 stay unsent; resumption starts at lastEventId + 1 and
		// the tracked IDs are the event sequences the client resumes from.
		expect(received.map(envelope)).toEqual([
			{ id: "3", data: { message: "event-3" } },
			{ id: "4", data: { message: "event-4" } },
			{ id: "5", data: { message: "event-5" } },
		]);
		expect(hub.stream.closeCount).toBe(1);
	});

	test("releases the subscription when the client disconnects mid-stream", async () => {
		const { ctx, hub } = makeContext([[{ id: UPDATE_ID }], [eventRow(1)]]);
		const iterator = await updatesRouter
			.createCaller(ctx)
			.onEvents({ org: "my-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		const generator = iterator[Symbol.asyncIterator]();
		await generator.next();
		// tRPC calls return() on the generator when the SSE client goes away.
		await generator.return?.(undefined);

		expect(hub.stream.closeCount).toBe(1);
	});

	test("releases the subscription when the listener connection fails", async () => {
		const { ctx, hub } = makeContext([[{ id: UPDATE_ID }], []]);
		const iterator = await updatesRouter
			.createCaller(ctx)
			.onEvents({ org: "my-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		const generator = iterator[Symbol.asyncIterator]();
		const next = generator.next();
		const stream = await openedStream(hub);
		stream.fail(new Error("connection terminated unexpectedly"));

		await expect(next).rejects.toThrow("connection terminated unexpectedly");
		expect(hub.stream.closeCount).toBe(1);
	});

	test("releases the subscription when the event query fails", async () => {
		const { ctx, hub } = makeContext([[{ id: UPDATE_ID }], new Error("query failed")]);
		const iterator = await updatesRouter
			.createCaller(ctx)
			.onEvents({ org: "my-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow("query failed");
		expect(hub.stream.closeCount).toBe(1);
	});

	test("surfaces the hub cap as TOO_MANY_REQUESTS", async () => {
		const hub = new TestHub();
		hub.rejectWith = new TRPCError({
			code: "TOO_MANY_REQUESTS",
			message: "Subscription limit reached (10 concurrent subscriptions per server).",
		});
		const { ctx } = makeContext([[{ id: UPDATE_ID }]], { hub });

		const iterator = await updatesRouter
			.createCaller(ctx)
			.onEvents({ org: "my-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		const error = await iterator[Symbol.asyncIterator]()
			.next()
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe("TOO_MANY_REQUESTS");
	});

	test("ends quietly when the client disconnects while the listener is being set up", async () => {
		const hub = new TestHub();
		const gate = Promise.withResolvers<void>();
		hub.setupGate = gate.promise;
		const { ctx } = makeContext([[{ id: UPDATE_ID }]], { hub });
		const controller = new AbortController();

		const iterator = await updatesRouter
			.createCaller(ctx, { signal: controller.signal })
			.onEvents({ org: "my-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		const first = iterator[Symbol.asyncIterator]().next();
		controller.abort();
		gate.resolve();

		// The client is gone: no error is raised and no stream was opened.
		expect((await first).done).toBe(true);
		expect(hub.subscribed).toHaveLength(0);
	});

	test("does not consume a subscription slot when stack authorization fails", async () => {
		const hub = new TestHub();
		const { ctx } = makeContext([], {
			hub,
			getStack: async () => {
				throw new TRPCError({ code: "FORBIDDEN", message: "no access" });
			},
		});

		const iterator = await updatesRouter
			.createCaller(ctx)
			.onEvents({ org: "other-org", project: "my-project", stack: "dev", updateId: UPDATE_ID });

		await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow("no access");
		expect(hub.subscribed).toHaveLength(0);
	});
});

// ============================================================================
// updates.onStackActivity
// ============================================================================

describe("updates.onStackActivity", () => {
	test("subscribes to stack_updates keyed by stack ID and emits on notification", async () => {
		const { ctx, hub } = makeContext([
			[
				{
					id: "update-9",
					kind: "update",
					result: "succeeded",
					version: 4,
					message: "",
					startedAt: new Date("2026-01-01T00:00:00Z"),
					completedAt: new Date("2026-01-01T00:01:00Z"),
				},
			],
			[{ fields: { summaryEvent: { resourceChanges: { create: 2 } } } }],
		]);

		const iterator = await updatesRouter
			.createCaller(ctx)
			.onStackActivity({ org: "my-org", project: "my-project", stack: "dev" });

		const generator = iterator[Symbol.asyncIterator]();
		const next = generator.next();
		const stream = await openedStream(hub);

		expect(hub.subscribed).toEqual([{ channel: "stack_updates", key: "stack-1" }]);
		stream.notify();

		expect(envelope((await next).value)).toEqual({
			id: "update-9",
			data: {
				updateID: "update-9",
				kind: "update",
				result: "succeeded",
				version: 4,
				message: "",
				startTime: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
				endTime: Math.floor(Date.parse("2026-01-01T00:01:00Z") / 1000),
				resourceChanges: { create: 2 },
			},
		});

		await generator.return?.(undefined);
		expect(stream.closeCount).toBe(1);
	});

	test("releases the subscription when the listener connection fails", async () => {
		const { ctx, hub } = makeContext([]);
		const iterator = await updatesRouter
			.createCaller(ctx)
			.onStackActivity({ org: "my-org", project: "my-project", stack: "dev" });

		const generator = iterator[Symbol.asyncIterator]();
		const next = generator.next();
		const stream = await openedStream(hub);
		stream.fail(new Error("connection terminated unexpectedly"));

		await expect(next).rejects.toThrow("connection terminated unexpectedly");
		expect(hub.stream.closeCount).toBe(1);
	});
});
