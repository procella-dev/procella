// Regression coverage: a live dashboard SSE subscription keeps its response
// in-flight, so `server.stop()` cannot drain until the notification hub is
// closed. Draining in the wrong order burns the force-exit timeout.

import { describe, expect, test } from "bun:test";
import { drainForShutdown } from "./shutdown.js";

describe("drainForShutdown", () => {
	test("closes subscriptions before the server so in-flight SSE responses can finish", async () => {
		const order: string[] = [];
		// Stands in for the open SSE response: it only completes once the
		// subscription stream has been ended by the hub.
		const openSseResponse = Promise.withResolvers<void>();

		await drainForShutdown({
			notifications: {
				close: async () => {
					order.push("notifications");
					openSseResponse.resolve();
				},
			},
			server: {
				stop: async () => {
					order.push("server");
					await openSseResponse.promise;
				},
			},
			workers: [
				{
					stop: async () => {
						order.push("gc");
					},
				},
				{
					stop: async () => {
						order.push("webhooks");
					},
				},
			],
		});

		expect(order).toEqual(["notifications", "server", "gc", "webhooks"]);
	});

	test("stops every worker after the server has drained", async () => {
		const order: string[] = [];
		let serverStopped = false;

		await drainForShutdown({
			notifications: { close: async () => {} },
			server: {
				stop: async () => {
					serverStopped = true;
				},
			},
			workers: [
				{
					stop: async () => {
						order.push(`gc:${serverStopped}`);
					},
				},
				{
					stop: async () => {
						order.push(`blobs:${serverStopped}`);
					},
				},
			],
		});

		expect(order).toEqual(["gc:true", "blobs:true"]);
	});
});
