// Regression coverage for the shutdown drain. A live dashboard SSE
// subscription keeps its response in-flight until its notification stream
// ends, and closing the notification hub takes a PostgreSQL roundtrip — so the
// two drains must run together. Either sequential order stalls: server-first
// waits on the open SSE response, hub-first keeps admitting requests while the
// force-exit timer runs.

import { describe, expect, test } from "bun:test";
import { drainForShutdown } from "./shutdown.js";

describe("drainForShutdown", () => {
	test("ends subscription streams while the server drains its in-flight SSE responses", async () => {
		// Stands in for the open SSE response: `server.stop()` completes only
		// once the hub has ended the subscription stream behind it.
		const openSseResponse = Promise.withResolvers<void>();

		await drainForShutdown({
			notifications: {
				close: async () => {
					openSseResponse.resolve();
				},
			},
			server: { stop: () => openSseResponse.promise },
			workers: [],
		});
	});

	test("halts admission without waiting for listener teardown", async () => {
		// Stands in for a slow PostgreSQL listener shutdown: it must not delay
		// `server.stop()`, otherwise late requests are admitted and then killed.
		const admissionHalted = Promise.withResolvers<void>();

		await drainForShutdown({
			notifications: { close: () => admissionHalted.promise },
			server: {
				stop: async () => {
					admissionHalted.resolve();
				},
			},
			workers: [],
		});
	});

	test("stops every worker after subscriptions and the server have drained", async () => {
		const order: string[] = [];
		let drained = 0;

		await drainForShutdown({
			notifications: {
				close: async () => {
					drained++;
				},
			},
			server: {
				stop: async () => {
					drained++;
				},
			},
			workers: [
				{
					stop: async () => {
						order.push(`gc:${drained}`);
					},
				},
				{
					stop: async () => {
						order.push(`webhooks:${drained}`);
					},
				},
			],
		});

		expect(order).toEqual(["gc:2", "webhooks:2"]);
	});
});
