import { expect, test } from "bun:test";
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

	await runGcInvocation({
		baseUrl: "http://runtime.test/2018-06-01/runtime",
		requestId: "request-1",
		gcWorker,
		githubOutbox: null,
		escGcSweep: async () => {},
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
});
