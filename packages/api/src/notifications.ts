// @procella/api — process-level PostgreSQL LISTEN/NOTIFY multiplexer for tRPC subscriptions.
//
// A dashboard subscriber used to open its own PostgreSQL connection and run
// LISTEN on it, so N concurrent subscribers held N backend connections and
// enough of them exhausted `max_connections`. This hub keeps at most one
// listener connection per channel per process and fans notifications out to
// in-process subscribers keyed by the NOTIFY payload (update ID / stack ID).
//
// Cluster-safety: all state here is per-process. Replicas each hold their own
// listener connection per active channel and enforce their own subscription
// cap; nothing is shared or coordinated across replicas.

import { TRPCError } from "@trpc/server";
import { Client } from "pg";

/** `application_name` reported by listener connections — makes them greppable in `pg_stat_activity`. */
export const NOTIFY_APPLICATION_NAME = "procella-notify";

/** Channels the hub is allowed to LISTEN on. Also guards identifier interpolation. */
export const NOTIFY_CHANNELS = {
	update_events: true,
	stack_updates: true,
} as const satisfies Record<string, true>;

export type NotifyChannel = keyof typeof NOTIFY_CHANNELS;

/** Default per-process ceiling on concurrent dashboard subscriptions. */
export const DEFAULT_MAX_CONCURRENT_SUBSCRIPTIONS = 500;

// ============================================================================
// Client seam
// ============================================================================

/** Minimal listener-connection surface — implemented by pg, faked in tests. */
export interface NotificationClient {
	connect(): Promise<void>;
	listen(channel: NotifyChannel): Promise<void>;
	onNotification(listener: (payload: string | undefined) => void): void;
	onError(listener: (error: Error) => void): void;
	end(): Promise<void>;
}

export type NotificationClientFactory = () => NotificationClient;

function createPgNotificationClient(connectionString: string): NotificationClient {
	const client = new Client({
		connectionString,
		application_name: NOTIFY_APPLICATION_NAME,
	});
	return {
		connect: async () => {
			await client.connect();
		},
		listen: async (channel) => {
			// `channel` is validated against NOTIFY_CHANNELS before reaching here;
			// LISTEN takes an identifier, which cannot be parameterized.
			await client.query(`LISTEN ${channel}`);
		},
		onNotification: (listener) => {
			client.on("notification", (message) => listener(message.payload));
		},
		onError: (listener) => {
			client.on("error", listener);
		},
		end: () => client.end(),
	};
}

// ============================================================================
// Public interface
// ============================================================================

/** One subscriber's view of a channel key. */
export interface NotificationStream {
	/**
	 * Resolve `true` when a notification for this key arrives, `false` once the
	 * subscription is aborted, closed, or the hub shuts down. Rejects when the
	 * listener connection fails, so the caller surfaces the error and the client
	 * reconnects with its resume token.
	 */
	wait(): Promise<boolean>;
	/** Release the subscription slot and detach every listener. Idempotent. */
	close(): void;
}

export interface NotificationHub {
	/** Per-process ceiling on concurrent subscriptions. */
	readonly maxConcurrent: number;
	/** Subscriptions currently holding a slot. */
	readonly activeSubscriptions: number;
	/** Listener connections currently open — at most one per active channel. */
	readonly openConnections: number;
	subscribe(channel: NotifyChannel, key: string, signal: AbortSignal): Promise<NotificationStream>;
	/** End every listener connection and stop accepting subscriptions. */
	close(): Promise<void>;
}

// ============================================================================
// Implementation
// ============================================================================

interface ChannelState {
	client: NotificationClient;
	ready: Promise<void>;
	keys: Map<string, Set<Subscriber>>;
	refCount: number;
	/** The client has been ended — by failure, by the last subscriber leaving, or by shutdown. */
	retired: boolean;
}

class Subscriber implements NotificationStream {
	private notified = false;
	private failure: unknown = null;
	private finished: boolean;
	private closed = false;
	private waiter: { resolve: (value: boolean) => void; reject: (error: unknown) => void } | null =
		null;
	private readonly onAbort = () => this.end();

	constructor(
		private readonly signal: AbortSignal,
		private readonly release: (subscriber: Subscriber) => void,
	) {
		this.finished = signal.aborted;
		if (!this.finished) signal.addEventListener("abort", this.onAbort, { once: true });
	}

	/** A NOTIFY for this key arrived. */
	notify(): void {
		const waiter = this.takeWaiter();
		if (waiter) waiter.resolve(true);
		else this.notified = true;
	}

	/** The listener connection failed — surface it to the subscriber. */
	fail(error: unknown): void {
		if (this.failure === null) this.failure = error;
		const waiter = this.takeWaiter();
		if (waiter) waiter.reject(this.failure);
	}

	/** Graceful end — abort or hub shutdown. */
	end(): void {
		this.finished = true;
		const waiter = this.takeWaiter();
		if (waiter) waiter.resolve(false);
	}

	wait(): Promise<boolean> {
		// Abort wins over buffered work; buffered work wins over a late failure so
		// already-notified events still reach the client before the error surfaces.
		if (this.finished || this.closed) return Promise.resolve(false);
		if (this.notified) {
			this.notified = false;
			return Promise.resolve(true);
		}
		if (this.failure !== null) return Promise.reject(this.failure);
		const { promise, resolve, reject } = Promise.withResolvers<boolean>();
		this.waiter = { resolve, reject };
		return promise;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.signal.removeEventListener("abort", this.onAbort);
		const waiter = this.takeWaiter();
		if (waiter) waiter.resolve(false);
		this.release(this);
	}

	private takeWaiter() {
		const waiter = this.waiter;
		this.waiter = null;
		return waiter;
	}
}

export interface PostgresNotificationHubOptions {
	connectionString: string;
	maxConcurrent?: number;
	/** Test seam — defaults to a real pg client using `connectionString`. */
	createClient?: NotificationClientFactory;
}

export class PostgresNotificationHub implements NotificationHub {
	readonly maxConcurrent: number;
	private readonly createClient: NotificationClientFactory;
	private readonly channels = new Map<NotifyChannel, ChannelState>();
	private active = 0;
	private closed = false;

	constructor(options: PostgresNotificationHubOptions) {
		this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUBSCRIPTIONS;
		this.createClient =
			options.createClient ?? (() => createPgNotificationClient(options.connectionString));
	}

	get activeSubscriptions(): number {
		return this.active;
	}

	get openConnections(): number {
		return this.channels.size;
	}

	async subscribe(
		channel: NotifyChannel,
		key: string,
		signal: AbortSignal,
	): Promise<NotificationStream> {
		if (NOTIFY_CHANNELS[channel] !== true) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: `Unknown notification channel: ${channel}`,
			});
		}
		if (this.closed) {
			throw new TRPCError({
				code: "SERVICE_UNAVAILABLE",
				message: "Server is shutting down; subscriptions are not being accepted",
			});
		}
		if (this.active >= this.maxConcurrent) {
			throw new TRPCError({
				code: "TOO_MANY_REQUESTS",
				message: `Subscription limit reached (${this.maxConcurrent} concurrent subscriptions per server). Retry shortly.`,
			});
		}

		this.active++;
		const state = this.ensureChannel(channel);
		const subscriber = new Subscriber(signal, (self) => this.release(channel, state, key, self));
		this.attach(state, key, subscriber);

		try {
			await state.ready;
		} catch (error) {
			subscriber.close();
			throw error;
		}
		return subscriber;
	}

	async close(): Promise<void> {
		this.closed = true;
		const states = [...this.channels.values()];
		this.channels.clear();
		await Promise.all(
			states.map(async (state) => {
				state.retired = true;
				for (const subscribers of state.keys.values()) {
					for (const subscriber of subscribers) subscriber.end();
				}
				await state.client.end().catch(() => {});
			}),
		);
	}

	private ensureChannel(channel: NotifyChannel): ChannelState {
		const existing = this.channels.get(channel);
		if (existing) return existing;

		const client = this.createClient();
		const state: ChannelState = {
			client,
			ready: Promise.resolve(),
			keys: new Map(),
			refCount: 0,
			retired: false,
		};

		// Attached before connecting so no notification or connection error is
		// missed between LISTEN being issued and the handler being registered.
		client.onNotification((payload) => {
			if (payload !== undefined) this.dispatch(state, payload);
		});
		client.onError((error) => this.failChannel(channel, state, error));

		state.ready = (async () => {
			await client.connect();
			await client.listen(channel);
		})();
		state.ready.catch((error) => this.failChannel(channel, state, error));

		this.channels.set(channel, state);
		return state;
	}

	private attach(state: ChannelState, key: string, subscriber: Subscriber): void {
		const subscribers = state.keys.get(key);
		if (subscribers) subscribers.add(subscriber);
		else state.keys.set(key, new Set([subscriber]));
		state.refCount++;
	}

	private dispatch(state: ChannelState, key: string): void {
		const subscribers = state.keys.get(key);
		if (!subscribers) return;
		for (const subscriber of subscribers) subscriber.notify();
	}

	private failChannel(channel: NotifyChannel, state: ChannelState, error: unknown): void {
		if (state.retired) return;
		state.retired = true;
		if (this.channels.get(channel) === state) this.channels.delete(channel);
		for (const subscribers of state.keys.values()) {
			for (const subscriber of subscribers) subscriber.fail(error);
		}
		void state.client.end().catch(() => {});
	}

	private release(
		channel: NotifyChannel,
		state: ChannelState,
		key: string,
		subscriber: Subscriber,
	): void {
		this.active = Math.max(0, this.active - 1);

		const subscribers = state.keys.get(key);
		if (subscribers) {
			subscribers.delete(subscriber);
			if (subscribers.size === 0) state.keys.delete(key);
		}

		// A retired channel already ended its client and dropped its registration.
		if (state.retired) return;

		state.refCount = Math.max(0, state.refCount - 1);
		if (state.refCount > 0) return;

		state.retired = true;
		if (this.channels.get(channel) === state) this.channels.delete(channel);
		void state.client.end().catch(() => {});
	}
}
