import { expect, jest, test } from "bun:test";
import { GCWorker } from "@procella/updates";
import { runGcInvocation } from "./gc-bootstrap.js";

test("GC Lambda reports an injected database failure and flushes telemetry", async () => {
	const gcWorker = new GCWorker({
		db: {
			transaction: () => Promise.reject(new Error("database unavailable")),
		} as never,
	});
	const requests: Array<{ url: string; body: string }> = [];
	let flushes = 0;
	let webhookRuns = 0;
	let blobCleanupRuns = 0;
	let escSweeps = 0;
	const drainOrder: string[] = [];

	await runGcInvocation({
		baseUrl: "http://runtime.test/2018-06-01/runtime",
		requestId: "request-1",
		gcWorker,
		blobCleanup: {
			runOnce: async () => {
				drainOrder.push("blob-cleanup");
				blobCleanupRuns += 1;
			},
		},
		webhookOutbox: {
			runOnce: async () => {
				drainOrder.push("webhook-outbox");
				webhookRuns += 1;
			},
		},
		escGcSweep: async () => {
			escSweeps += 1;
		},
		flushTelemetry: async () => {
			flushes += 1;
		},
		runtimeFetch: async (input, init) => {
			requests.push({ url: String(input), body: String(init?.body) });
			return new Response();
		},
	});

	expect(requests).toHaveLength(1);
	expect(requests[0]?.url).toEndWith("/invocation/request-1/error");
	expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
		errorMessage: "database unavailable",
		errorType: "Error",
	});
	expect(flushes).toBe(1);
	expect(webhookRuns).toBe(1);
	expect(blobCleanupRuns).toBe(1);
	expect(drainOrder).toEqual(["webhook-outbox", "blob-cleanup"]);
	expect(escSweeps).toBe(1);
});

test("GC Lambda bounds a stalled telemetry flush", async () => {
	jest.useFakeTimers();
	const { promise: started, resolve: flushStarted } = Promise.withResolvers<void>();
	const requests: string[] = [];

	try {
		const invocation = runGcInvocation({
			baseUrl: "http://runtime.test/2018-06-01/runtime",
			requestId: "request-2",
			gcWorker: { runOnce: async () => {} },
			blobCleanup: { runOnce: async () => {} },
			webhookOutbox: { runOnce: async () => {} },
			escGcSweep: async () => {},
			flushTelemetry: () => {
				flushStarted();
				return Promise.withResolvers<void>().promise;
			},
			runtimeFetch: async (input) => {
				requests.push(String(input));
				return new Response();
			},
		});

		await started;
		jest.advanceTimersByTime(3_000);
		await invocation;

		expect(requests).toEqual([
			"http://runtime.test/2018-06-01/runtime/invocation/request-2/response",
		]);
	} finally {
		jest.useRealTimers();
	}
});
