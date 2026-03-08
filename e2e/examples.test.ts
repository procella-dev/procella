// E2E — Go example programs: full lifecycle for each example.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	copyExampleDir,
	createPulumiHome,
	pulumi,
	truncateTables,
} from "./helpers.js";

// Examples take time: Go compilation + provider plugin downloads.
setDefaultTimeout(180_000);

let pulumiHome: string;

beforeAll(async () => {
	pulumiHome = await createPulumiHome();
	await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
});

afterAll(async () => {
	await cleanupDir(pulumiHome);
	await truncateTables();
});

// ============================================================================
// Helper: run the standard full lifecycle for a Go example
// ============================================================================

function runExampleLifecycle(
	exampleName: string,
	opts: {
		configSteps?: Array<{ key: string; value: string }>;
		skipDestroyRm?: boolean;
	} = {},
): void {
	const stackFQN = `dev-org/${exampleName}/dev`;
	const stackPath = `/stacks/dev-org/${exampleName}/dev`;
	let dir: string;

	beforeAll(async () => {
		dir = await copyExampleDir(exampleName);
	});

	afterAll(async () => {
		if (dir) await cleanupDir(dir);
	});

	test("stack init", async () => {
		const res = await pulumi(["stack", "init", stackFQN], { cwd: dir, pulumiHome });
		expect(res.exitCode).toBe(0);
	});

	for (const { key, value } of opts.configSteps ?? []) {
		test(`config set ${key}`, async () => {
			const res = await pulumi(["config", "set", key, value], { cwd: dir, pulumiHome });
			expect(res.exitCode).toBe(0);
		});
	}

	test("pulumi up", async () => {
		const res = await pulumi(["up", "--yes"], { cwd: dir, pulumiHome });
		expect(res.exitCode).toBe(0);
	});

	test("pulumi preview", async () => {
		const res = await pulumi(["preview"], { cwd: dir, pulumiHome });
		expect(res.exitCode).toBe(0);
	});

	test("pulumi refresh", async () => {
		const res = await pulumi(["refresh", "--yes"], { cwd: dir, pulumiHome });
		expect(res.exitCode).toBe(0);
	});

	test("export returns resources", async () => {
		const res = await apiRequest(`${stackPath}/export`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.deployment).toBeDefined();
	});

	test("import roundtrip", async () => {
		const exportRes = await apiRequest(`${stackPath}/export`);
		const deployment = await exportRes.json();
		const importRes = await apiRequest(`${stackPath}/import`, {
			method: "POST",
			body: deployment,
		});
		expect(importRes.status).toBe(200);
		const result = await importRes.json();
		expect(result).toHaveProperty("updateId");
	});

	if (!opts.skipDestroyRm) {
		test("pulumi destroy", async () => {
			const res = await pulumi(["destroy", "--yes"], { cwd: dir, pulumiHome });
			expect(res.exitCode).toBe(0);
		});

		test("pulumi stack rm", async () => {
			const res = await pulumi(["stack", "rm", "--yes"], { cwd: dir, pulumiHome });
			expect(res.exitCode).toBe(0);
		});
	}
}

// ============================================================================
// Examples
// ============================================================================

describe("example: multi-resource", () => {
	runExampleLifecycle("multi-resource");
});

describe("example: secrets-heavy", () => {
	runExampleLifecycle("secrets-heavy", {
		configSteps: [{ key: "dbHost", value: "testdb.example.com" }],
	});
});

describe("example: component", () => {
	runExampleLifecycle("component");
});

describe("example: replace-triggers", () => {
	runExampleLifecycle("replace-triggers");
});

describe("example: large-state", () => {
	runExampleLifecycle("large-state");
});

describe("example: protect", () => {
	// Protect flag blocks destroy by design — skip destroy and rm.
	// Stack is cleaned up via truncateTables() in afterAll.
	runExampleLifecycle("protect", { skipDestroyRm: true });
});
