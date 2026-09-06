import { describe, expect, test } from "bun:test";
import type { SubscriptionTicketScope } from "@procella/types";
import { Window } from "happy-dom";

const dom = new Window({ url: "https://procella.dev/" });
globalThis.window = dom as unknown as typeof globalThis.window;

class FakeEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static readonly instances: FakeEventSource[] = [];

	readonly CONNECTING = FakeEventSource.CONNECTING;
	readonly OPEN = FakeEventSource.OPEN;
	readonly CLOSED = FakeEventSource.CLOSED;
	readonly url: string;
	readonly withCredentials = false;
	readyState = FakeEventSource.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return true;
	}
	close(): void {
		this.readyState = FakeEventSource.CLOSED;
	}

	emitMessage(lastEventId: string): void {
		this.onmessage?.({ lastEventId } as MessageEvent);
	}

	emitErrorWhileReconnecting(): void {
		this.readyState = FakeEventSource.CONNECTING;
		this.onerror?.(new Event("error"));
	}
}

async function flushConnections(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("ticket-refreshing EventSource", () => {
	test("mints a new ticket on native reconnect and preserves the replay cursor", async () => {
		const { createTicketRefreshingEventSource } = await import("./trpc.js");
		FakeEventSource.instances.length = 0;
		const ticketScopes: SubscriptionTicketScope[] = [];
		const reconnects: Array<() => void> = [];
		const EventSourceWithFreshTickets = createTicketRefreshingEventSource(
			FakeEventSource as unknown as typeof EventSource,
			async (scope) => {
				ticketScopes.push(scope);
				return `ticket-${ticketScopes.length}`;
			},
			(reconnect) => reconnects.push(reconnect),
		);
		if (!EventSourceWithFreshTickets) throw new Error("EventSource factory was not created");
		const input = {
			json: {
				org: "my-org",
				project: "my-project",
				stack: "dev",
				updateId: "update-1",
			},
			meta: { values: {} },
		};
		const url = new URL("https://procella.dev/trpc/updates.onEvents");
		url.searchParams.set("input", JSON.stringify(input));

		const source = new EventSourceWithFreshTickets(url.toString());
		await flushConnections();
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(new URL(FakeEventSource.instances[0].url).searchParams.get("ticket")).toBe("ticket-1");

		FakeEventSource.instances[0].emitMessage("17");
		FakeEventSource.instances[0].emitErrorWhileReconnecting();
		await flushConnections();
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(reconnects).toHaveLength(1);

		reconnects.shift()?.();
		await flushConnections();
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CLOSED);
		const reconnectUrl = new URL(FakeEventSource.instances[1].url);
		expect(reconnectUrl.searchParams.get("ticket")).toBe("ticket-2");
		expect(JSON.parse(reconnectUrl.searchParams.get("input") ?? "null")).toEqual({
			...input,
			json: { ...input.json, lastEventId: 17 },
		});
		expect(ticketScopes).toEqual([
			{ procedure: "updates.onEvents", resource: input.json },
			{ procedure: "updates.onEvents", resource: input.json },
		]);
		source.close();
	});

	test("keeps a closed EventSource closed when a pending ticket request rejects after close()", async () => {
		const { createTicketRefreshingEventSource } = await import("./trpc.js");
		FakeEventSource.instances.length = 0;
		const reconnects: Array<() => void> = [];
		let rejectTicket!: (error: unknown) => void;
		const pendingTicket = new Promise<string>((_resolve, reject) => {
			rejectTicket = reject;
		});
		const EventSourceWithFreshTickets = createTicketRefreshingEventSource(
			FakeEventSource as unknown as typeof EventSource,
			() => pendingTicket,
			(reconnect) => reconnects.push(reconnect),
		);
		if (!EventSourceWithFreshTickets) throw new Error("EventSource factory was not created");
		const input = {
			json: {
				org: "my-org",
				project: "my-project",
				stack: "dev",
				updateId: "update-1",
			},
			meta: { values: {} },
		};
		const url = new URL("https://procella.dev/trpc/updates.onEvents");
		url.searchParams.set("input", JSON.stringify(input));

		const source = new EventSourceWithFreshTickets(url.toString());
		const errors: Event[] = [];
		source.onerror = (event) => errors.push(event);

		// close() while the ticket mint is still pending — no native EventSource was
		// ever opened, so #source.close() is a no-op and only #closed/#readyState flip.
		source.close();
		expect(source.readyState).toBe(FakeEventSource.CLOSED);

		rejectTicket(new Error("ticket service unavailable"));
		await flushConnections();

		expect(source.readyState).toBe(FakeEventSource.CLOSED);
		expect(errors).toHaveLength(0);
		expect(reconnects).toHaveLength(0);
		expect(FakeEventSource.instances).toHaveLength(0);
	});
});
