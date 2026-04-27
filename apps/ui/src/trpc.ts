import type { AppRouter } from "@procella/api/src/router/index.js";
import {
	createTRPCUntypedClient,
	httpBatchLink,
	httpSubscriptionLink,
	splitLink,
} from "@trpc/client";
import { type CreateTRPCReact, createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import { getStoredDescopeSessionToken } from "./auth/sessionToken";
import { apiBase } from "./config";
import { getAuthConfig } from "./hooks/useAuthConfig";

type TicketResponse = { ticket: string };

type EventSourceListener = EventListenerOrEventListenerObject;

let ticketClient: ReturnType<typeof createTRPCUntypedClient<AppRouter>> | null = null;

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export function getAuthHeaders(): Record<string, string> {
	const config = getAuthConfig();

	if (config?.mode === "descope") {
		const token = getStoredDescopeSessionToken();
		if (!token) return {};
		return { Authorization: `Bearer ${token}` };
	}

	const token = localStorage.getItem("procella-token") ?? "";
	if (!token) return {};
	return { Authorization: `token ${token}` };
}

function getTicketClient() {
	if (ticketClient) {
		return ticketClient;
	}

	ticketClient = createTRPCUntypedClient<AppRouter>({
		links: [
			httpBatchLink({
				url: `${apiBase}/trpc`,
				headers: getAuthHeaders,
				transformer: superjson,
			}),
		],
	});

	return ticketClient;
}

function isTicketResponse(value: unknown): value is TicketResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	return "ticket" in value && typeof value.ticket === "string";
}

async function fetchSubscriptionTicket(): Promise<string> {
	const result = await getTicketClient().mutation("subscriptions.createTicket", undefined);
	if (!isTicketResponse(result)) {
		throw new Error("Invalid subscription ticket response");
	}

	return result.ticket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceLastEventId(lastEventId: string): number | string {
	const numeric = Number(lastEventId);
	return Number.isFinite(numeric) ? numeric : lastEventId;
}

function withLastEventId(url: URL, lastEventId: string | undefined): void {
	if (!lastEventId) {
		return;
	}

	const input = url.searchParams.get("input");
	if (!input) {
		return;
	}

	try {
		const parsed = JSON.parse(input);
		if (!isRecord(parsed)) {
			return;
		}

		url.searchParams.set(
			"input",
			JSON.stringify({
				...parsed,
				lastEventId: coerceLastEventId(lastEventId),
			}),
		);
	} catch {
		// Ignore malformed client-generated URLs and reconnect without replay state.
	}
}

async function buildSubscriptionUrl(baseUrl: string, lastEventId?: string): Promise<string> {
	const url = new URL(baseUrl);
	url.searchParams.set("ticket", await fetchSubscriptionTicket());
	withLastEventId(url, lastEventId);
	return url.toString();
}

function dispatchListener(listener: EventSourceListener, event: Event): void {
	if (typeof listener === "function") {
		listener(event);
		return;
	}

	listener.handleEvent(event);
}

function createTicketRefreshingEventSource() {
	const NativeEventSource = globalThis.EventSource;
	if (!NativeEventSource) {
		return undefined;
	}

	type EventSourceInit = ConstructorParameters<typeof EventSource>[1];

	return class TicketRefreshingEventSource {
		static readonly CONNECTING = NativeEventSource.CONNECTING;
		static readonly OPEN = NativeEventSource.OPEN;
		static readonly CLOSED = NativeEventSource.CLOSED;

		readonly CONNECTING = NativeEventSource.CONNECTING;
		readonly OPEN = NativeEventSource.OPEN;
		readonly CLOSED = NativeEventSource.CLOSED;

		readonly url: string;
		readonly withCredentials: boolean;

		#readyState: number = NativeEventSource.CONNECTING;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;

		#closed = false;
		#connecting = false;
		#init: EventSourceInit | undefined;
		#lastEventId: string | undefined;
		#listeners = new Map<string, Set<EventSourceListener>>();
		#source: EventSource | null = null;

		constructor(url: string, init?: EventSourceInit) {
			this.url = url;
			this.withCredentials = Boolean(init?.withCredentials);
			this.#init = init;
			void this.#connect();
		}

		get readyState(): number {
			return this.#readyState;
		}

		addEventListener(type: string, listener: EventSourceListener | null): void {
			if (!listener) {
				return;
			}

			const listeners = this.#listeners.get(type) ?? new Set<EventSourceListener>();
			listeners.add(listener);
			this.#listeners.set(type, listeners);
		}

		removeEventListener(type: string, listener: EventSourceListener | null): void {
			if (!listener) {
				return;
			}

			this.#listeners.get(type)?.delete(listener);
		}

		dispatchEvent(event: Event): boolean {
			this.#emit(event.type, event);
			return true;
		}

		close(): void {
			this.#closed = true;
			this.#readyState = NativeEventSource.CLOSED;
			this.#source?.close();
		}

		async #connect(): Promise<void> {
			if (this.#closed || this.#connecting) {
				return;
			}

			this.#connecting = true;
			try {
				const authenticatedUrl = await buildSubscriptionUrl(this.url, this.#lastEventId);
				if (this.#closed) {
					return;
				}

				const source = new NativeEventSource(authenticatedUrl, this.#init);
				this.#source = source;
				this.#readyState = source.readyState;

				source.onopen = (event) => {
					this.#readyState = source.readyState;
					this.onopen?.(event);
					this.#emit("open", event);
				};

				source.onmessage = (event) => {
					if (event.lastEventId) {
						this.#lastEventId = event.lastEventId;
					}
					this.#readyState = source.readyState;
					this.onmessage?.(event);
					this.#emit("message", event);
				};

				source.onerror = (event) => {
					this.#readyState = source.readyState;
					this.onerror?.(event);
					this.#emit("error", event);

					if (!this.#closed && source.readyState === NativeEventSource.CLOSED) {
						source.close();
						queueMicrotask(() => {
							void this.#connect();
						});
					}
				};
			} catch (error) {
				this.#readyState = NativeEventSource.CLOSED;
				const event = new CustomEvent("error", { detail: error });
				this.onerror?.(event);
				this.#emit("error", event);
				if (!this.#closed) {
					setTimeout(() => {
						void this.#connect();
					}, 1000);
				}
			} finally {
				this.#connecting = false;
			}
		}

		#emit(type: string, event: Event): void {
			for (const listener of this.#listeners.get(type) ?? []) {
				dispatchListener(listener, event);
			}
		}
	};
}

export function createTRPCClient() {
	const TicketRefreshingEventSource = createTicketRefreshingEventSource();

	return createTRPCUntypedClient({
		links: [
			splitLink({
				condition: (op) => op.type === "subscription",
				true: httpSubscriptionLink({
					url: `${apiBase}/trpc`,
					...(TicketRefreshingEventSource ? { EventSource: TicketRefreshingEventSource } : {}),
					transformer: superjson,
				}),
				false: httpBatchLink({
					url: `${apiBase}/trpc`,
					headers: getAuthHeaders,
					transformer: superjson,
				}),
			}),
		],
	});
}
