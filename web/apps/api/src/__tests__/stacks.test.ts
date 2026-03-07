import { describe, expect, it } from "bun:test";
import { appRouter } from "../router/index.js";
import { staticDb, testContext } from "./helpers.js";

describe("stacks.list", () => {
	it("returns stacks for the caller's org", async () => {
		const db = staticDb([
			{
				orgName: "test-org",
				projectName: "my-project",
				stackName: "dev",
				tags: { env: "development" },
				version: 3,
				activeUpdate: null,
			},
			{
				orgName: "test-org",
				projectName: "my-project",
				stackName: "prod",
				tags: {},
				version: 7,
				activeUpdate: "update-123",
			},
		]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.stacks.list();

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			orgName: "test-org",
			projectName: "my-project",
			stackName: "dev",
			tags: { env: "development" },
			version: 3,
			activeUpdate: "",
			currentOperation: "",
		});
		expect(result[1]).toEqual({
			orgName: "test-org",
			projectName: "my-project",
			stackName: "prod",
			tags: {},
			version: 7,
			activeUpdate: "update-123",
			currentOperation: "in-progress",
		});
	});

	it("returns empty array when no stacks exist", async () => {
		const db = staticDb([]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.stacks.list();

		expect(result).toEqual([]);
	});

	it("coerces null tags to empty object", async () => {
		const db = staticDb([
			{
				orgName: "test-org",
				projectName: "p",
				stackName: "s",
				tags: null,
				version: 0,
				activeUpdate: null,
			},
		]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.stacks.list();

		expect(result[0]?.tags).toEqual({});
	});
});

describe("stacks.get", () => {
	it("returns a single stack by org/project/stack", async () => {
		const db = staticDb([
			{
				orgName: "test-org",
				projectName: "infra",
				stackName: "staging",
				tags: { region: "us-east-1" },
				version: 5,
				activeUpdate: null,
			},
		]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.stacks.get({
			org: "test-org",
			project: "infra",
			stack: "staging",
		});

		expect(result).toEqual({
			orgName: "test-org",
			projectName: "infra",
			stackName: "staging",
			tags: { region: "us-east-1" },
			version: 5,
			activeUpdate: "",
			currentOperation: "",
		});
	});

	it("returns null when stack not found", async () => {
		const db = staticDb([]);
		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.stacks.get({
			org: "test-org",
			project: "missing",
			stack: "nope",
		});

		expect(result).toBeNull();
	});

	it("shows in-progress when activeUpdate is set", async () => {
		const db = staticDb([
			{
				orgName: "test-org",
				projectName: "p",
				stackName: "s",
				tags: {},
				version: 1,
				activeUpdate: "abc-123",
			},
		]);

		const caller = appRouter.createCaller(testContext(db));
		const result = await caller.stacks.get({
			org: "test-org",
			project: "p",
			stack: "s",
		});

		expect(result?.activeUpdate).toBe("abc-123");
		expect(result?.currentOperation).toBe("in-progress");
	});
});
