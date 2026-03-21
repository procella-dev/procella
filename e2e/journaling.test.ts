// E2E — Journaling protocol: startUpdate echoes journalVersion, full lifecycle.

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

const RANDOM_PET_PROGRAM = `name: journaling-test
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 2
outputs:
  petName: \${pet.id}
`;

describe("journaling protocol", () => {
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

	test("startUpdate echoes journalVersion when client requests it", async () => {
		projectDir = await newProjectDir("journaling-test");
		await Bun.write(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);

		const initRes = await pulumi(["stack", "init", "dev-org/journaling-test/dev"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(initRes.exitCode).toBe(0);

		const createRes = await apiRequest("/stacks/dev-org/journaling-test/dev/update", {
			method: "POST",
			body: {},
		});
		expect(createRes.status).toBe(200);
		const { updateID } = await createRes.json();

		const startRes = await apiRequest(`/stacks/dev-org/journaling-test/dev/update/${updateID}`, {
			method: "POST",
			body: { journalVersion: 1 },
		});
		expect(startRes.status).toBe(200);
		const startBody = await startRes.json();
		expect(startBody.journalVersion).toBe(1);

		await apiRequest(`/stacks/dev-org/journaling-test/dev/update/${updateID}/cancel`, {
			method: "POST",
		});
	});

	test("pulumi up + destroy work with journaling active", async () => {
		const upDir = await newProjectDir("journal-compat");
		await Bun.write(path.join(upDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		try {
			const initRes = await pulumi(["stack", "init", "dev-org/journaling-test/compat"], {
				cwd: upDir,
				pulumiHome,
			});
			expect(initRes.exitCode).toBe(0);

			const upRes = await pulumi(["up", "--yes"], { cwd: upDir, pulumiHome });
			expect(upRes.exitCode).toBe(0);

			const destroyRes = await pulumi(["destroy", "--yes"], { cwd: upDir, pulumiHome });
			expect(destroyRes.exitCode).toBe(0);
		} finally {
			await cleanupDir(upDir);
		}
	});
});
