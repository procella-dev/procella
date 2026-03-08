// E2E — Stack rename: success, 404 on nonexistent, 409 on conflict.

import { afterAll, describe, expect, test } from "bun:test";
import { apiRequest, truncateTables } from "./helpers.js";

describe("stack rename", () => {
	afterAll(async () => {
		await truncateTables();
	});

	test("rename stack succeeds", async () => {
		// Create source stack
		const createRes = await apiRequest("/stacks/dev-org/rename-proj/rename-src", {
			method: "POST",
		});
		expect(createRes.status).toBe(200);

		// Rename it
		const renameRes = await apiRequest("/stacks/dev-org/rename-proj/rename-src/rename", {
			method: "POST",
			body: { newName: "rename-dst" },
		});
		expect(renameRes.status).toBe(204);

		// Old name is gone
		const oldRes = await apiRequest("/stacks/dev-org/rename-proj/rename-src");
		expect(oldRes.status).toBe(404);

		// New name exists
		const newRes = await apiRequest("/stacks/dev-org/rename-proj/rename-dst");
		expect(newRes.status).toBe(200);
		const stack = await newRes.json();
		expect(stack.stackName).toBe("rename-dst");
	});

	test("rename nonexistent stack returns 404", async () => {
		const res = await apiRequest("/stacks/dev-org/rename-proj/ghost/rename", {
			method: "POST",
			body: { newName: "whatever" },
		});
		expect(res.status).toBe(404);
	});

	test("rename to conflicting name returns 409", async () => {
		await apiRequest("/stacks/dev-org/rename-proj/conflict-a", { method: "POST" });
		await apiRequest("/stacks/dev-org/rename-proj/conflict-b", { method: "POST" });

		const res = await apiRequest("/stacks/dev-org/rename-proj/conflict-a/rename", {
			method: "POST",
			body: { newName: "conflict-b" },
		});
		expect(res.status).toBe(409);
	});
});
