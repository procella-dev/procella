import { describe, expect, mock, test } from "bun:test";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { updateHandlers } from "./updates.js";

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
};

const mockStackInfo: StackInfo = {
	id: "stack-uuid-1",
	projectId: "proj-uuid-1",
	tenantId: "t-1",
	orgName: "myorg",
	projectName: "myproj",
	stackName: "dev",
	tags: { env: "dev" },
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

function mockStacksService(overrides?: Partial<StacksService>): StacksService {
	return {
		createStack: mock(async () => mockStackInfo),
		getStack: mock(async () => mockStackInfo),
		listStacks: mock(async () => [mockStackInfo]),
		deleteStack: mock(async () => {}),
		renameStack: mock(async () => {}),
		updateStackTags: mock(async () => {}),
		replaceStackTags: mock(async () => {}),
		getStackByFQN: mock(async () => mockStackInfo),
		getStackByNames: mock(async () => mockStackInfo),
		...overrides,
	};
}

const mockCreateResult = { updateID: "upd-1", requiredPolicies: [] };
const mockStartResult = { version: 1, token: "lease-tok", tokenExpiration: "2025-01-01T01:00:00Z" };
const mockGetUpdateResult = { status: "succeeded", startTime: 0, endTime: 1 };
const mockHistoryResult = { updates: [] };

function mockUpdatesService(overrides?: Partial<UpdatesService>): UpdatesService {
	return {
		createUpdate: mock(async () => mockCreateResult as never),
		startUpdate: mock(async () => mockStartResult as never),
		completeUpdate: mock(async () => {}),
		cancelUpdate: mock(async () => {}),
		patchCheckpoint: mock(async () => {}),
		patchCheckpointVerbatim: mock(async () => {}),
		patchCheckpointDelta: mock(async () => {}),
		appendJournalEntries: mock(async () => {}),
		postEvents: mock(async () => {}),
		renewLease: mock(async () => ({}) as never),
		getUpdate: mock(async () => mockGetUpdateResult as never),
		getUpdateEvents: mock(async () => ({}) as never),
		getHistory: mock(async () => mockHistoryResult as never),
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

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

describe("updateHandlers", () => {
	test("createUpdate returns updateID and requiredPolicies", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/:kind", h.createUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/update", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { key: "val" } }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updateID).toBe("upd-1");
		expect(body.requiredPolicies).toBeArray();
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.createUpdate).toHaveBeenCalledWith(
			"stack-uuid-1",
			"update",
			{ key: "val" },
			undefined,
		);
	});

	test("createUpdate handles empty body gracefully", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/stacks/:org/:project/:stack/:kind", h.createUpdate);

		const res = await app.request("/stacks/myorg/myproj/dev/preview", {
			method: "POST",
		});

		expect(res.status).toBe(200);
		expect(updates.createUpdate).toHaveBeenCalledWith(
			"stack-uuid-1",
			"preview",
			undefined,
			undefined,
		);
	});

	test("startUpdate returns version, token, and expiration", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/updates/:updateId/start", h.startUpdate);

		const reqBody = { tags: { "pulumi:target": "*" } };
		const res = await app.request("/updates/upd-1/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toBe(1);
		expect(body.token).toBe("lease-tok");
		expect(body.tokenExpiration).toBe("2025-01-01T01:00:00Z");
		expect(updates.startUpdate).toHaveBeenCalledWith("upd-1", reqBody);
	});

	test("completeUpdate returns 204", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", async (c, next) => {
			c.set("updateContext", { updateId: "upd-1", stackId: "s-1" });
			await next();
		});
		const h = updateHandlers(updates, stacks);
		app.post("/updates/:updateId/complete", h.completeUpdate);

		const reqBody = { status: "succeeded" };
		const res = await app.request("/updates/upd-1/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(204);
		expect(updates.completeUpdate).toHaveBeenCalledWith("upd-1", reqBody);
	});

	test("cancelUpdate returns 204", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.post("/updates/:updateId/cancel", h.cancelUpdate);

		const res = await app.request("/updates/upd-1/cancel", { method: "POST" });
		expect(res.status).toBe(204);
		expect(updates.cancelUpdate).toHaveBeenCalledWith("upd-1");
	});

	test("getUpdate returns update results", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.get("/updates/:updateId", h.getUpdate);

		const res = await app.request("/updates/upd-42");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("succeeded");
		expect(updates.getUpdate).toHaveBeenCalledWith("upd-42");
	});

	test("getHistory returns updates array", async () => {
		const updates = mockUpdatesService();
		const stacks = mockStacksService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		const h = updateHandlers(updates, stacks);
		app.get("/stacks/:org/:project/:stack/updates", h.getHistory);

		const res = await app.request("/stacks/myorg/myproj/dev/updates");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updates).toBeArray();
		expect(stacks.getStack).toHaveBeenCalledWith("t-1", "myorg", "myproj", "dev");
		expect(updates.getHistory).toHaveBeenCalledWith("stack-uuid-1");
	});
});
