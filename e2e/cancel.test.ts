// E2E — Cancel update: success, idempotency, stack usable after cancel.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	pulumi,
	truncateTables,
} from "./helpers.js";

const RANDOM_PET_PROGRAM = `name: cancel-proj
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 2
`;

const STACK_PATH = "/stacks/dev-org/cancel-proj/cancel-stack";

describe("cancel update", () => {
	let pulumiHome: string;
	let updateId: string;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
		await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
	});

	afterAll(async () => {
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("cancel running update returns 204", async () => {
		// Create stack
		const createStackRes = await apiRequest(STACK_PATH, { method: "POST" });
		expect(createStackRes.status).toBe(200);

		// Create update
		const createUpdateRes = await apiRequest(`${STACK_PATH}/update`, {
			method: "POST",
			body: {},
		});
		expect(createUpdateRes.status).toBe(200);
		const { updateID } = await createUpdateRes.json();
		updateId = updateID;

		// Start update (acquire lease)
		const startRes = await apiRequest(`${STACK_PATH}/update/${updateId}`, {
			method: "POST",
			body: {},
		});
		expect(startRes.status).toBe(200);

		// Cancel — must return 204
		const cancelRes = await apiRequest(`${STACK_PATH}/update/${updateId}/cancel`, {
			method: "POST",
		});
		expect(cancelRes.status).toBe(204);

		// Verify status is cancelled
		const getRes = await apiRequest(`${STACK_PATH}/update/${updateId}`);
		expect(getRes.status).toBe(200);
		const body = await getRes.json();
		expect(body.status).toBe("cancelled");
	});

	test("cancel already-cancelled update is idempotent (204)", async () => {
		const cancelRes = await apiRequest(`${STACK_PATH}/update/${updateId}/cancel`, {
			method: "POST",
		});
		expect(cancelRes.status).toBe(204);
	});

	test("stack usable after cancel", async () => {
		const projectDir = await newProjectDir("cancel-proj");
		await Bun.write(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		try {
			const selectRes = await pulumi(["stack", "select", "dev-org/cancel-proj/cancel-stack"], {
				cwd: projectDir,
				pulumiHome,
			});
			expect(selectRes.exitCode).toBe(0);

			const upRes = await pulumi(["up", "--yes"], { cwd: projectDir, pulumiHome });
			expect(upRes.exitCode).toBe(0);
		} finally {
			await cleanupDir(projectDir);
		}
	});
});
