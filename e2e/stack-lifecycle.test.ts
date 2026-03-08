// E2E — Stack lifecycle: create, get, list, tags, delete via HTTP API + CLI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	pulumi,
	truncateTables,
} from "./helpers.js";

describe("stack lifecycle", () => {
	let pulumiHome: string;
	let projectDir: string;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
		await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
	});

	afterAll(async () => {
		if (projectDir) await cleanupDir(projectDir);
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("create stack via 3-segment route", async () => {
		const res = await apiRequest("/stacks/dev-org/e2e-project/dev", { method: "POST" });
		expect(res.status).toBe(200);
		const stack = await res.json();
		expect(stack.orgName).toBe("dev-org");
		expect(stack.projectName).toBe("e2e-project");
		expect(stack.stackName).toBe("dev");
	});

	test("create stack via 2-segment route (stack name in body)", async () => {
		const res = await apiRequest("/stacks/dev-org/e2e-project", {
			method: "POST",
			body: { stackName: "staging" },
		});
		expect(res.status).toBe(200);
		const stack = await res.json();
		expect(stack.orgName).toBe("dev-org");
		expect(stack.projectName).toBe("e2e-project");
		expect(stack.stackName).toBe("staging");
	});

	test("duplicate stack creation fails with 409", async () => {
		const res = await apiRequest("/stacks/dev-org/e2e-project/dev", { method: "POST" });
		expect(res.status).toBe(409);
	});

	test("get stack returns stack details", async () => {
		const res = await apiRequest("/stacks/dev-org/e2e-project/dev");
		expect(res.status).toBe(200);
		const stack = await res.json();
		expect(stack.orgName).toBe("dev-org");
		expect(stack.projectName).toBe("e2e-project");
		expect(stack.stackName).toBe("dev");
		expect(stack.tags).toBeDefined();
	});

	test("list stacks returns all stacks", async () => {
		const res = await apiRequest("/stacks");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.stacks).toBeArray();
		expect(body.stacks.length).toBeGreaterThanOrEqual(2);
		const names = body.stacks.map((s: { stackName: string }) => s.stackName);
		expect(names).toContain("dev");
		expect(names).toContain("staging");
	});

	test("update stack tags", async () => {
		const patchRes = await apiRequest("/stacks/dev-org/e2e-project/dev/tags", {
			method: "PATCH",
			body: { env: "development", team: "platform" },
		});
		expect(patchRes.status).toBe(204);

		const getRes = await apiRequest("/stacks/dev-org/e2e-project/dev");
		expect(getRes.status).toBe(200);
		const stack = await getRes.json();
		expect(stack.tags.env).toBe("development");
		expect(stack.tags.team).toBe("platform");
	});

	test("delete stack removes it", async () => {
		const delRes = await apiRequest("/stacks/dev-org/e2e-project/staging", {
			method: "DELETE",
		});
		expect(delRes.status).toBe(204);

		const getRes = await apiRequest("/stacks/dev-org/e2e-project/staging");
		expect(getRes.status).toBe(404);
	});

	test("get non-existent stack returns 404", async () => {
		const res = await apiRequest("/stacks/dev-org/e2e-project/does-not-exist");
		expect(res.status).toBe(404);
	});

	test("pulumi stack init via CLI", async () => {
		projectDir = await newProjectDir("cli-lifecycle");
		const res = await pulumi(["stack", "init", "dev-org/cli-lifecycle/cli-stack"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(res.exitCode).toBe(0);
	});

	test("pulumi stack ls via CLI", async () => {
		const res = await pulumi(["stack", "ls"], { cwd: projectDir, pulumiHome });
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain("cli-stack");
	});

	test("pulumi stack select via CLI", async () => {
		const res = await pulumi(["stack", "select", "dev-org/cli-lifecycle/cli-stack"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(res.exitCode).toBe(0);
	});

	test("pulumi stack rm via CLI", async () => {
		const res = await pulumi(["stack", "rm", "--yes", "dev-org/cli-lifecycle/cli-stack"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(res.exitCode).toBe(0);
	});

	test("GET /api/user returns user info", async () => {
		const res = await apiRequest("/user");
		expect(res.status).toBe(200);
		const user = await res.json();
		expect(user).toHaveProperty("githubLogin");
		expect(user).toHaveProperty("organizations");
	});

	test("GET /api/user/stacks returns stacks", async () => {
		const res = await apiRequest("/user/stacks");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.stacks).toBeArray();
	});

	test("GET /api/user/organizations/:orgName returns org info", async () => {
		const res = await apiRequest("/user/organizations/dev-org");
		expect(res.status).toBe(200);
		const org = await res.json();
		expect(org.githubLogin).toBe("dev-org");
		expect(org.name).toBe("dev-org");
	});
});
