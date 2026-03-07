import { describe, expect, it } from "bun:test";
import { appRouter } from "../router/index.js";
import { staticDb, testContext } from "./helpers.js";

const baseDate = new Date("2025-03-01T12:00:00Z");

function makeUpdateRow(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		updateId: "upd-001",
		kind: "update",
		status: "succeeded",
		version: 1,
		config: { "aws:region": { value: "us-east-1", secret: false } },
		metadata: { message: "Updating infrastructure", environment: { stack: "dev" } },
		createdAt: baseDate,
		startedAt: new Date(baseDate.getTime() + 1000),
		completedAt: new Date(baseDate.getTime() + 60_000),
		...overrides,
	};
}

describe("updates.list", () => {
	it("returns paginated updates for a stack", async () => {
		const db = staticDb([
			makeUpdateRow({ updateId: "upd-002", version: 2 }),
			makeUpdateRow({ updateId: "upd-001", version: 1 }),
		]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.list({
			org: "test-org",
			project: "my-project",
			stack: "dev",
		});

		expect(result).toHaveLength(2);
		expect(result[0]?.updateID).toBe("upd-002");
		expect(result[1]?.updateID).toBe("upd-001");
	});

	it("maps status to UI-friendly result strings", async () => {
		const statuses = [
			{ status: "succeeded", expected: "succeeded" },
			{ status: "failed", expected: "failed" },
			{ status: "cancelled", expected: "cancelled" },
			{ status: "running", expected: "in-progress" },
			{ status: "not started", expected: "not-started" },
			{ status: "requested", expected: "not-started" },
		];

		for (const { status, expected } of statuses) {
			const db = staticDb([makeUpdateRow({ status })]);
			const caller = appRouter.createCaller(testContext(db));
			const result = await caller.updates.list({
				org: "o",
				project: "p",
				stack: "s",
			});

			expect(result[0]?.result).toBe(expected);
		}
	});

	it("converts timestamps to unix seconds", async () => {
		const startedAt = new Date("2025-03-01T12:00:01Z");
		const completedAt = new Date("2025-03-01T12:01:00Z");

		const db = staticDb([makeUpdateRow({ startedAt, completedAt })]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.list({
			org: "o",
			project: "p",
			stack: "s",
		});

		expect(result[0]?.startTime).toBe(Math.floor(startedAt.getTime() / 1000));
		expect(result[0]?.endTime).toBe(Math.floor(completedAt.getTime() / 1000));
	});

	it("returns 0 for null timestamps", async () => {
		const db = staticDb([makeUpdateRow({ startedAt: null, completedAt: null })]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.list({
			org: "o",
			project: "p",
			stack: "s",
		});

		expect(result[0]?.startTime).toBe(0);
		expect(result[0]?.endTime).toBe(0);
	});

	it("extracts message from metadata", async () => {
		const db = staticDb([makeUpdateRow({ metadata: { message: "Deploy v2.1.0" } })]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.list({
			org: "o",
			project: "p",
			stack: "s",
		});

		expect(result[0]?.message).toBe("Deploy v2.1.0");
	});

	it("returns empty array when no updates exist", async () => {
		const db = staticDb([]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.list({
			org: "o",
			project: "p",
			stack: "s",
		});

		expect(result).toEqual([]);
	});

	it("accepts custom pagination parameters", async () => {
		const db = staticDb([makeUpdateRow()]);
		const caller = appRouter.createCaller(testContext(db));

		// Should not throw with valid pagination
		const result = await caller.updates.list({
			org: "o",
			project: "p",
			stack: "s",
			page: 2,
			pageSize: 10,
		});

		expect(result).toBeDefined();
	});
});

describe("updates.latest", () => {
	it("returns the most recent update", async () => {
		const db = staticDb([makeUpdateRow({ updateId: "latest-upd", version: 5 })]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.latest({
			org: "test-org",
			project: "my-project",
			stack: "dev",
		});

		expect(result).not.toBeNull();
		expect(result?.updateID).toBe("latest-upd");
		expect(result?.version).toBe(5);
	});

	it("returns null when no updates exist", async () => {
		const db = staticDb([]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.latest({
			org: "o",
			project: "p",
			stack: "s",
		});

		expect(result).toBeNull();
	});

	it("includes config and environment from metadata", async () => {
		const db = staticDb([
			makeUpdateRow({
				config: { key: { value: "val", secret: false } },
				metadata: { environment: { CLOUD: "aws" } },
			}),
		]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.updates.latest({
			org: "o",
			project: "p",
			stack: "s",
		});

		expect(result?.config).toEqual({ key: { value: "val", secret: false } });
		expect(result?.environment).toEqual({ CLOUD: "aws" });
	});
});
