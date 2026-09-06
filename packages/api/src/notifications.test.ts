import { describe, expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import {
	type NotificationClient,
	type NotifyChannel,
	PostgresNotificationHub,
} from "./notifications.js";

// ============================================================================
// Fake listener connection
// ============================================================================

class FakeClient implements NotificationClient {
	static created: FakeClient[] = [];

	connected = false;
	ended = false;
	listening: NotifyChannel | null = null;
	connectError: Error | null = null;
	/** Holds `connect()` open to simulate a stalled listener setup. */
	connectGate: Promise<void> | null = null;
	private notificationListener: ((payload: string | undefined) => void) | null = null;
	private errorListener: ((error: Error) => void) | null = null;

	constructor() {
		FakeClient.created.push(this);
	}

	async connect(): Promise<void> {
		if (this.connectGate) await this.connectGate;
		if (this.connectError) throw this.connectError;
		this.connected = true;
	}

	async listen(channel: NotifyChannel): Promise<void> {
		this.listening = channel;
	}

	onNotification(listener: (payload: string | undefined) => void): void {
		this.notificationListener = listener;
	}

	onError(listener: (error: Error) => void): void {
		this.errorListener = listener;
	}

	async end(): Promise<void> {
		this.ended = true;
	}

	/** Simulate a PostgreSQL NOTIFY on this connection. */
	emit(payload: string | undefined): void {
		this.notificationListener?.(payload);
	}

	/** Simulate the connection dropping. */
	emitError(error: Error): void {
		this.errorListener?.(error);
	}
}

function makeHub(options?: { maxConcurrent?: number }) {
	FakeClient.created = [];
	const hub = new PostgresNotificationHub({
		connectionString: "postgres://unused.invalid/db",
		maxConcurrent: options?.maxConcurrent,
		createClient: () => new FakeClient(),
	});
	return { hub, clients: () => FakeClient.created };
}

const never = new AbortController().signal;

describe("PostgresNotificationHub", () => {
	test("shares one listener connection across many subscribers on a channel", async () => {
		const { hub, clients } = makeHub();

		const streams = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				hub.subscribe("update_events", `update-${i % 5}`, never),
			),
		);

		expect(clients()).toHaveLength(1);
		expect(clients()[0]?.listening).toBe("update_events");
		expect(hub.openConnections).toBe(1);
		expect(hub.activeSubscriptions).toBe(50);

		for (const stream of streams) stream.close();
		expect(hub.openConnections).toBe(0);
		expect(hub.activeSubscriptions).toBe(0);
		expect(clients()[0]?.ended).toBe(true);
	});

	test("opens one connection per distinct channel", async () => {
		const { hub, clients } = makeHub();

		await hub.subscribe("update_events", "update-1", never);
		await hub.subscribe("stack_updates", "stack-1", never);
		await hub.subscribe("update_events", "update-2", never);

		expect(clients()).toHaveLength(2);
		expect(
			clients()
				.map((c) => c.listening)
				.sort(),
		).toEqual(["stack_updates", "update_events"]);
	});

	test("delivers a notification only to subscribers of the matching key", async () => {
		const { hub, clients } = makeHub();

		const wanted = await hub.subscribe("update_events", "update-1", never);
		const other = await hub.subscribe("update_events", "update-2", never);

		const wantedWait = wanted.wait();
		let otherResolved = false;
		void other.wait().then(() => {
			otherResolved = true;
		});

		clients()[0]?.emit("update-1");

		expect(await wantedWait).toBe(true);
		await Promise.resolve();
		expect(otherResolved).toBe(false);
	});

	test("buffers a notification that arrives while the subscriber is busy", async () => {
		const { hub, clients } = makeHub();
		const stream = await hub.subscribe("update_events", "update-1", never);

		// No pending wait() — this is the window where the old per-subscriber
		// listener dropped the wakeup entirely.
		clients()[0]?.emit("update-1");

		expect(await stream.wait()).toBe(true);
	});

	test("coalesces repeated notifications instead of queueing them", async () => {
		const { hub, clients } = makeHub();
		const stream = await hub.subscribe("update_events", "update-1", never);

		clients()[0]?.emit("update-1");
		clients()[0]?.emit("update-1");
		clients()[0]?.emit("update-1");

		expect(await stream.wait()).toBe(true);

		const second = stream.wait();
		const raced = await Promise.race([second, Promise.resolve("pending" as const)]);
		expect(raced).toBe("pending");
	});

	test("rejects subscriptions beyond the configured cap with TOO_MANY_REQUESTS", async () => {
		const { hub } = makeHub({ maxConcurrent: 2 });

		const first = await hub.subscribe("update_events", "update-1", never);
		const second = await hub.subscribe("stack_updates", "stack-1", never);

		const error = await hub.subscribe("update_events", "update-2", never).catch((e) => e);
		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe("TOO_MANY_REQUESTS");
		expect((error as TRPCError).message).toContain("2");

		// A released slot is immediately reusable.
		first.close();
		const third = await hub.subscribe("update_events", "update-3", never);
		expect(hub.activeSubscriptions).toBe(2);

		second.close();
		third.close();
	});

	test("closing a subscriber twice releases exactly one slot", async () => {
		const { hub } = makeHub();
		const stream = await hub.subscribe("update_events", "update-1", never);
		const other = await hub.subscribe("update_events", "update-2", never);

		stream.close();
		stream.close();

		expect(hub.activeSubscriptions).toBe(1);
		other.close();
		expect(hub.activeSubscriptions).toBe(0);
	});

	test("keeps the connection open while other subscribers remain", async () => {
		const { hub, clients } = makeHub();
		const first = await hub.subscribe("update_events", "update-1", never);
		const second = await hub.subscribe("update_events", "update-1", never);

		first.close();
		expect(clients()[0]?.ended).toBe(false);
		expect(hub.openConnections).toBe(1);

		second.close();
		expect(clients()[0]?.ended).toBe(true);
		expect(hub.openConnections).toBe(0);
	});

	test("surfaces listener connection failures and drops the connection", async () => {
		const { hub, clients } = makeHub();
		const stream = await hub.subscribe("update_events", "update-1", never);
		const pending = stream.wait();

		const failure = new Error("connection terminated");
		clients()[0]?.emitError(failure);

		await expect(pending).rejects.toThrow("connection terminated");
		expect(clients()[0]?.ended).toBe(true);
		expect(hub.openConnections).toBe(0);

		stream.close();
		expect(hub.activeSubscriptions).toBe(0);

		// The next subscriber gets a fresh connection.
		const revived = await hub.subscribe("update_events", "update-1", never);
		expect(clients()).toHaveLength(2);
		revived.close();
	});

	test("reports a failure raised between notifications on the next wait", async () => {
		const { hub, clients } = makeHub();
		const stream = await hub.subscribe("update_events", "update-1", never);

		clients()[0]?.emitError(new Error("boom"));

		await expect(stream.wait()).rejects.toThrow("boom");
		stream.close();
	});

	test("releases the slot when the listener connection never comes up", async () => {
		FakeClient.created = [];
		const hub = new PostgresNotificationHub({
			connectionString: "postgres://unused.invalid/db",
			createClient: () => {
				const client = new FakeClient();
				client.connectError = new Error("ECONNREFUSED");
				return client;
			},
		});

		await expect(hub.subscribe("update_events", "update-1", never)).rejects.toThrow("ECONNREFUSED");
		expect(hub.activeSubscriptions).toBe(0);
		expect(hub.openConnections).toBe(0);
	});

	test("ends the subscription when the request is aborted", async () => {
		const { hub } = makeHub();
		const controller = new AbortController();
		const stream = await hub.subscribe("update_events", "update-1", controller.signal);

		const pending = stream.wait();
		controller.abort();

		expect(await pending).toBe(false);
		expect(await stream.wait()).toBe(false);

		stream.close();
		expect(hub.activeSubscriptions).toBe(0);
	});

	test("rejects an already-aborted request without opening a connection", async () => {
		const { hub, clients } = makeHub();

		await expect(hub.subscribe("update_events", "update-1", AbortSignal.abort())).rejects.toThrow(
			"aborted before the listener was ready",
		);
		expect(clients()).toHaveLength(0);
		expect(hub.activeSubscriptions).toBe(0);
	});

	test("releases the slot when the client disconnects while the listener is connecting", async () => {
		FakeClient.created = [];
		const stalled = Promise.withResolvers<void>();
		const hub = new PostgresNotificationHub({
			connectionString: "postgres://unused.invalid/db",
			maxConcurrent: 1,
			createClient: () => {
				const client = new FakeClient();
				client.connectGate = stalled.promise;
				return client;
			},
		});

		const controller = new AbortController();
		const pending = hub.subscribe("update_events", "update-1", controller.signal);
		await Promise.resolve();
		expect(hub.activeSubscriptions).toBe(1);

		controller.abort();

		await expect(pending).rejects.toThrow("aborted before the listener was ready");
		// The slot is free again even though the connection attempt is still stalled,
		// so unrelated subscribers are not rejected by a hung listener setup.
		expect(hub.activeSubscriptions).toBe(0);
		expect(hub.openConnections).toBe(0);
		expect(FakeClient.created[0]?.ended).toBe(true);

		stalled.resolve();
	});

	test("close() ends every connection and stops accepting subscriptions", async () => {
		const { hub, clients } = makeHub();
		const events = await hub.subscribe("update_events", "update-1", never);
		const activity = await hub.subscribe("stack_updates", "stack-1", never);
		const pending = events.wait();

		await hub.close();

		expect(await pending).toBe(false);
		expect(await activity.wait()).toBe(false);
		expect(clients().every((c) => c.ended)).toBe(true);
		expect(hub.openConnections).toBe(0);

		await expect(hub.subscribe("update_events", "update-1", never)).rejects.toThrow(
			"shutting down",
		);

		events.close();
		activity.close();
		expect(hub.activeSubscriptions).toBe(0);
	});

	test("ignores notifications without a payload", async () => {
		const { hub, clients } = makeHub();
		const stream = await hub.subscribe("update_events", "update-1", never);

		clients()[0]?.emit(undefined);

		const raced = await Promise.race([stream.wait(), Promise.resolve("pending" as const)]);
		expect(raced).toBe("pending");
		stream.close();
	});
});
