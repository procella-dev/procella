import { describe, expect, it } from "bun:test";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
	it("delivers published events to subscriber", async () => {
		const bus = new EventBus();
		const received: unknown[][] = [];
		bus.subscribe("upd-1", (events) => received.push(events));
		bus.publish("upd-1", [{ seq: 1 }]);
		expect(received).toEqual([[{ seq: 1 }]]);
	});

	it("unsubscribe stops delivery", () => {
		const bus = new EventBus();
		const received: unknown[][] = [];
		const unsub = bus.subscribe("upd-1", (events) => received.push(events));
		unsub();
		bus.publish("upd-1", [{ seq: 1 }]);
		expect(received).toHaveLength(0);
	});

	it("clears all subscribers for update", () => {
		const bus = new EventBus();
		const received: unknown[][] = [];
		bus.subscribe("upd-1", (events) => received.push(events));
		bus.clear("upd-1");
		bus.publish("upd-1", [{ seq: 1 }]);
		expect(received).toHaveLength(0);
	});

	it("fans out to multiple subscribers", () => {
		const bus = new EventBus();
		let count = 0;
		bus.subscribe("upd-1", () => count++);
		bus.subscribe("upd-1", () => count++);
		bus.publish("upd-1", [{}]);
		expect(count).toBe(2);
	});
});
