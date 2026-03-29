import { describe, expect, mock, test } from "bun:test";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import { errorHandler } from "../middleware/error-handler.js";
import type { Env } from "../types.js";
import { eventHandlers } from "./events.js";

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => ({ updateID: "", requiredPolicies: [] }) as never),
		startUpdate: mock(async () => ({}) as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => {}),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(
			async () => ({ token: "new-lease", tokenExpiration: "2025-01-01T01:00:00Z" }) as never,
		),
		getUpdate: mock(async () => ({}) as never),
		getUpdateEvents: mock(
			async () =>
				({
					events: [{ sequence: 1, kind: "stdout", fields: {} }],
					continuationToken: "tok-2",
				}) as never,
		),
		getHistory: mock(async () => ({}) as never),
		exportStack: mock(async () => ({}) as never),
		importStack: mock(async () => ({}) as never),
		encryptValue: mock(async () => new Uint8Array()),
		decryptValue: mock(async () => new Uint8Array()),
		batchEncrypt: mock(async () => []),
		batchDecrypt: mock(async () => []),
		verifyLeaseToken: mock(async () => {}),
		...overrides,
	};
}

function injectUpdateContext(updateId: string, stackId: string) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("updateContext", { updateId, stackId });
		await next();
	};
}

describe("eventHandlers", () => {
	test("postEvents calls service and returns 200", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-1", "s-1"));
		const h = eventHandlers(updates);
		app.post("/events", h.postEvents);

		const body = { events: [{ sequence: 1, timestamp: 0 }] };
		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		expect(res.status).toBe(200);
		expect(updates.postEvents).toHaveBeenCalledTimes(1);
		expect(updates.postEvents).toHaveBeenCalledWith("u-1", body);
	});

	test("getUpdateEvents returns events with continuationToken", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = eventHandlers(updates);
		app.get("/updates/:updateId/events", h.getUpdateEvents);

		const res = await app.request("/updates/upd-42/events");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events).toBeArray();
		expect(body.continuationToken).toBe("tok-2");
		expect(updates.getUpdateEvents).toHaveBeenCalledWith("upd-42", undefined);
	});

	test("getUpdateEvents passes continuationToken query param", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		const h = eventHandlers(updates);
		app.get("/updates/:updateId/events", h.getUpdateEvents);

		const res = await app.request("/updates/upd-42/events?continuationToken=tok-1");
		expect(res.status).toBe(200);
		expect(updates.getUpdateEvents).toHaveBeenCalledWith("upd-42", "tok-1");
	});

	test("renewLease calls service and returns new token", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.use("*", injectUpdateContext("u-5", "s-5"));
		const h = eventHandlers(updates);
		app.post("/renew", h.renewLease);

		const reqBody = { token: "old-lease" };
		const res = await app.request("/renew", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.token).toBe("new-lease");
		expect(body.tokenExpiration).toBe("2025-01-01T01:00:00Z");
		expect(updates.renewLease).toHaveBeenCalledWith("u-5", reqBody);
	});

	test("postEvents throws when updateContext is not set", async () => {
		const updates = mockUpdatesService();
		const app = new Hono<Env>();
		app.onError(errorHandler());
		const h = eventHandlers(updates);
		app.post("/events", h.postEvents);

		const res = await app.request("/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: [] }),
		});

		expect(res.status).toBe(400);
	});
});
