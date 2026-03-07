import { describe, expect, it } from "bun:test";
import { appRouter } from "../router/index.js";
import { mockDb, testContext } from "./helpers.js";

// Events router makes two queries:
// 1. Verify the update belongs to caller's org (returns { id, status })
// 2. Fetch events after the continuation token
//
// Our mock resolves different data based on which method in the chain
// is called — the first chain starts with select({id, status}),
// the second starts with select({sequence, timestamp, eventData}).

function eventsDb(opts: {
	update?: { id: string; status: string } | null;
	events?: Array<{ sequence: number; timestamp: number; eventData: unknown }>;
}) {
	let callCount = 0;
	return mockDb(() => {
		callCount++;
		// First query: update existence check
		if (callCount === 1) {
			return opts.update ? [opts.update] : [];
		}
		// Second query: events
		return opts.events ?? [];
	});
}

describe("events.list", () => {
	const validInput = {
		org: "test-org",
		project: "my-project",
		stack: "dev",
		updateID: "550e8400-e29b-41d4-a716-446655440000",
	};

	it("returns events for a valid update", async () => {
		const db = eventsDb({
			update: { id: validInput.updateID, status: "succeeded" },
			events: [
				{ sequence: 0, timestamp: 1709300000, eventData: { kind: "preludeEvent" } },
				{
					sequence: 1,
					timestamp: 1709300001,
					eventData: { kind: "resourcePreEvent", metadata: { op: "create" } },
				},
				{
					sequence: 2,
					timestamp: 1709300002,
					eventData: { kind: "resourceOutputsEvent", metadata: { op: "create" } },
				},
			],
		});

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list(validInput);

		expect(result.events).toHaveLength(3);
		expect(result.events[0]).toMatchObject({
			sequence: 0,
			timestamp: 1709300000,
			kind: "preludeEvent",
		});
		expect(result.events[1]).toMatchObject({
			sequence: 1,
			kind: "resourcePreEvent",
		});
	});

	it("returns empty events when update not found", async () => {
		const db = eventsDb({ update: null });
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list(validInput);

		expect(result.events).toEqual([]);
		expect(result.continuationToken).toBeNull();
	});

	it("returns continuation token when update is still running", async () => {
		const db = eventsDb({
			update: { id: validInput.updateID, status: "running" },
			events: [
				{ sequence: 0, timestamp: 1709300000, eventData: { kind: "preludeEvent" } },
				{ sequence: 1, timestamp: 1709300001, eventData: { kind: "resourcePreEvent" } },
			],
		});

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list(validInput);

		expect(result.events).toHaveLength(2);
		expect(result.continuationToken).toBe("1"); // last sequence number
	});

	it("returns null continuation token when update is completed", async () => {
		const db = eventsDb({
			update: { id: validInput.updateID, status: "succeeded" },
			events: [{ sequence: 0, timestamp: 1709300000, eventData: { kind: "summaryEvent" } }],
		});

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list(validInput);

		expect(result.continuationToken).toBeNull();
	});

	it("supports continuation token for pagination", async () => {
		const db = eventsDb({
			update: { id: validInput.updateID, status: "succeeded" },
			events: [{ sequence: 5, timestamp: 1709300005, eventData: { kind: "resourceOutputsEvent" } }],
		});

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list({
			...validInput,
			continuationToken: "4",
		});

		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.sequence).toBe(5);
	});

	it("returns continuation token when batch is full (100 events)", async () => {
		const events = Array.from({ length: 100 }, (_, i) => ({
			sequence: i,
			timestamp: 1709300000 + i,
			eventData: { kind: "event" },
		}));

		const db = eventsDb({
			update: { id: validInput.updateID, status: "succeeded" },
			events,
		});

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list(validInput);

		expect(result.events).toHaveLength(100);
		// Even though update is completed, 100 events = full batch = continuation token
		expect(result.continuationToken).toBe("99");
	});

	it("returns continuation for not-started updates", async () => {
		const db = eventsDb({
			update: { id: validInput.updateID, status: "not started" },
			events: [],
		});

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.events.list(validInput);

		expect(result.events).toEqual([]);
		// not-started is still "running" → should have continuation token
		// but no events means the token stays as the input token (null in this case)
		expect(result.continuationToken).toBeNull();
	});
});
