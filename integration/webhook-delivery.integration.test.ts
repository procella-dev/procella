import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AesCryptoService } from "@procella/crypto";
import { type Database, updates, webhookDeliveries, webhookOutbox, webhooks } from "@procella/db";
import { PostgresStacksService } from "@procella/stacks";
import { LocalBlobStorage } from "@procella/storage";
import type { Caller } from "@procella/types";
import { GCWorker, PostgresUpdatesService } from "@procella/updates";
import { PostgresWebhooksService, WebhookOutboxWorker } from "@procella/webhooks";
import { asc, eq } from "drizzle-orm";
import { getTestDb, truncateTables } from "./setup.js";

let db: Database;
let stacksService: PostgresStacksService;
let updatesService: PostgresUpdatesService;
let webhooksService: PostgresWebhooksService;
let blobDir: string;
let sequence = 0;

const caller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "org-1",
	userId: "user-1",
	login: "octocat",
	roles: [],
	principalType: "user",
};

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * The worker's transport is injected so delivery is deterministic and hermetic: no socket is
 * opened, yet the exact bytes and headers the worker would put on the wire are captured.
 */
function makeFetcher(respond: (request: CapturedRequest, index: number) => Promise<Response>) {
	const requests: CapturedRequest[] = [];
	const fetcher = (async (input: string, init: RequestInit) => {
		// The worker always passes a plain header record; RequestInit widens it to HeadersInit.
		const headers = init.headers as Record<string, string>;
		const request: CapturedRequest = {
			url: String(input),
			headers: { ...headers },
			body: String(init.body),
		};
		requests.push(request);
		return respond(request, requests.length - 1);
	}) as unknown as typeof fetch;
	return { fetcher, requests };
}

const ok = async () => new Response("ok", { status: 200 });

function worker(fetcher: typeof fetch, workerId?: string): WebhookOutboxWorker {
	return new WebhookOutboxWorker({ db, fetcher, workerId, maxPerRun: 10 });
}

async function createHook(
	tenantId: string,
	events: string[],
	url = "https://1.1.1.1/hook",
): Promise<{ id: string; secret: string }> {
	const hook = await webhooksService.createWebhook(
		tenantId,
		{ name: `hook-${tenantId}-${events.join("-")}`, url, events, secret: `secret-${tenantId}` },
		"user-1",
	);
	return { id: hook.id, secret: hook.secret };
}

async function startedUpdate(): Promise<string> {
	sequence += 1;
	const stack = await stacksService.createStack("tenant-1", "org-1", "infra", `stack-${sequence}`);
	const created = await updatesService.createUpdate(
		stack.id,
		"update",
		undefined,
		undefined,
		caller,
	);
	await updatesService.startUpdate(created.updateID, {});
	return created.updateID;
}

function pendingIntents() {
	return db.select().from(webhookOutbox).orderBy(asc(webhookOutbox.createdAt));
}

function deliveryHistory() {
	return db.select().from(webhookDeliveries).orderBy(asc(webhookDeliveries.createdAt));
}

beforeAll(async () => {
	db = getTestDb();
	stacksService = new PostgresStacksService({ db });
	blobDir = await mkdtemp(path.join(tmpdir(), "procella-webhook-outbox-"));
	updatesService = new PostgresUpdatesService({
		db,
		storage: new LocalBlobStorage(blobDir),
		crypto: new AesCryptoService("a".repeat(64)),
	});
	webhooksService = new PostgresWebhooksService({ db });
});

afterAll(async () => {
	await rm(blobDir, { recursive: true, force: true });
});

afterEach(async () => {
	await truncateTables();
});

describe("durable webhook delivery", () => {
	test("persists the intent with the lifecycle commit and delivers it after a crash before HTTP", async () => {
		await createHook("tenant-1", ["update.started", "update.succeeded"]);
		const updateId = await startedUpdate();
		await updatesService.completeUpdate(updateId, { status: "succeeded" });

		// The process dies here: the lifecycle transaction committed, no HTTP request was made.
		const intents = await pendingIntents();
		expect(intents.map((intent) => intent.event)).toEqual([
			"update.started",
			"update.succeeded",
		]);
		expect(JSON.parse(intents[1].body)).toMatchObject({
			event: "update.succeeded",
			data: {
				org: "org-1",
				project: "infra",
				stack: expect.stringContaining("stack-"),
				updateId,
				status: "succeeded",
			},
		});
		expect(await deliveryHistory()).toHaveLength(0);

		// A replica that restarts afterwards owes both deliveries and makes them.
		const { fetcher, requests } = makeFetcher(ok);
		expect(await worker(fetcher).runOnce()).toBe(2);
		expect(requests.map((request) => request.headers["X-Webhook-Event"])).toEqual([
			"update.started",
			"update.succeeded",
		]);
		expect(await pendingIntents()).toHaveLength(0);
		const history = await deliveryHistory();
		expect(history.map((row) => [row.event, row.success, row.attempt])).toEqual([
			["update.started", true, 1],
			["update.succeeded", true, 1],
		]);
	});

	test("signs the exact stored body and repeats it byte-for-byte on retry", async () => {
		const hook = await createHook("tenant-1", ["update.succeeded"]);
		const updateId = await startedUpdate();
		await updatesService.completeUpdate(updateId, { status: "succeeded" });
		const [intent] = await pendingIntents();

		const { fetcher, requests } = makeFetcher(async (_request, index) =>
			index === 0 ? new Response("boom", { status: 503 }) : new Response("ok", { status: 200 }),
		);
		const outbox = worker(fetcher);

		expect(await outbox.runOnce()).toBe(0);
		const [retrying] = await pendingIntents();
		expect(retrying.attempts).toBe(1);
		expect(retrying.claimedBy).toBeNull();
		expect(retrying.failedAt).toBeNull();
		expect(retrying.lastError).toContain("503");
		expect(retrying.availableAt.getTime()).toBeGreaterThan(Date.now() + 1_000);

		await db
			.update(webhookOutbox)
			.set({ availableAt: new Date() })
			.where(eq(webhookOutbox.id, intent.id));
		expect(await outbox.runOnce()).toBe(1);

		const expected = `sha256=${createHmac("sha256", hook.secret).update(requests[0].body, "utf8").digest("hex")}`;
		expect(requests[0].headers).toEqual({
			"Content-Type": "application/json",
			"X-Webhook-Signature": expected,
			"X-Webhook-Event": "update.succeeded",
			"X-Webhook-Id": hook.id,
			"X-Webhook-Delivery": intent.id,
			"User-Agent": "Procella-Webhooks/1.0",
		});
		expect(requests[1].body).toBe(requests[0].body);
		expect(requests[1].headers).toEqual(requests[0].headers);
		expect(requests[0].body).toBe(intent.body);

		const history = await deliveryHistory();
		expect(history.map((row) => [row.attempt, row.success])).toEqual([
			[1, false],
			[2, true],
		]);
		expect(await pendingIntents()).toHaveLength(0);
	});

	test("two workers racing the same intent deliver it exactly once", async () => {
		await createHook("tenant-1", ["update.succeeded"]);
		const updateId = await startedUpdate();
		await updatesService.completeUpdate(updateId, { status: "succeeded" });

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = makeFetcher(async () => {
			entered.resolve();
			await release.promise;
			return new Response("ok", { status: 200 });
		});
		const second = makeFetcher(ok);

		const firstRun = worker(first.fetcher).runOnce();
		await entered.promise;
		expect(await worker(second.fetcher).runOnce()).toBe(0);
		release.resolve();
		expect(await firstRun).toBe(1);

		expect(first.requests).toHaveLength(1);
		expect(second.requests).toHaveLength(0);
		expect(await deliveryHistory()).toHaveLength(1);
		expect(await pendingIntents()).toHaveLength(0);
	});

	test("only webhooks of the owning tenant that subscribe to the event receive an intent", async () => {
		const subscribed = await createHook("tenant-1", ["update.succeeded"]);
		await createHook("tenant-2", ["update.succeeded"], "https://1.0.0.1/hook");
		await createHook("tenant-1", ["stack.deleted"], "https://8.8.8.8/hook");
		const inactive = await createHook("tenant-1", ["update.succeeded"], "https://8.8.4.4/hook");
		await db.update(webhooks).set({ active: false }).where(eq(webhooks.id, inactive.id));

		const updateId = await startedUpdate();
		await updatesService.completeUpdate(updateId, { status: "succeeded" });

		const intents = await pendingIntents();
		expect(intents).toHaveLength(1);
		expect(intents[0].webhookId).toBe(subscribed.id);
		expect(intents[0].tenantId).toBe("tenant-1");
	});

	test("enqueues cancellations from both the API path and the GC worker", async () => {
		await createHook("tenant-1", ["update.cancelled"]);

		const cancelled = await startedUpdate();
		expect(await updatesService.cancelUpdate(cancelled)).toBe(true);

		const orphaned = await startedUpdate();
		await db
			.update(updates)
			.set({ leaseExpiresAt: new Date(Date.now() - 120_000) })
			.where(eq(updates.id, orphaned));
		await new GCWorker({ db }).runOnce();

		const intents = await pendingIntents();
		expect(intents).toHaveLength(2);
		expect(intents.map((intent) => JSON.parse(intent.body))).toMatchObject([
			{ event: "update.cancelled", data: { updateId: cancelled } },
			{ event: "update.cancelled", data: { updateId: orphaned } },
		]);
		expect(intents.every((intent) => intent.event === "update.cancelled")).toBe(true);
	});

	test("dead-letters a rejected delivery instead of retrying a request the endpoint refuses", async () => {
		await createHook("tenant-1", ["update.succeeded"]);
		const updateId = await startedUpdate();
		await updatesService.completeUpdate(updateId, { status: "succeeded" });

		const { fetcher, requests } = makeFetcher(async () => new Response("nope", { status: 422 }));
		const outbox = worker(fetcher);

		expect(await outbox.runOnce()).toBe(0);
		const [dead] = await pendingIntents();
		expect(dead.failedAt).toBeInstanceOf(Date);
		expect(dead.attempts).toBe(1);
		expect(dead.lastError).toContain("422");

		expect(await outbox.runOnce()).toBe(0);
		expect(requests).toHaveLength(1);
	});
});
