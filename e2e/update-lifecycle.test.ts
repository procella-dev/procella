// E2E — Update lifecycle: preview, up, destroy, refresh, outputs, conflict detection.

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

// Minimal inline YAML program using the random provider.
const RANDOM_PET_PROGRAM = `name: update-test
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 2
outputs:
  petName: \${pet.id}
`;

describe("update lifecycle", () => {
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

	test("pulumi preview succeeds", async () => {
		projectDir = await newProjectDir("update-test");
		await Bun.write(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		const initRes = await pulumi(["stack", "init", "dev-org/update-test/dev"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(initRes.exitCode).toBe(0);

		const previewRes = await pulumi(["preview"], { cwd: projectDir, pulumiHome });
		expect(previewRes.exitCode).toBe(0);
		const combined = previewRes.stdout + previewRes.stderr;
		expect(combined.toLowerCase()).toContain("create");
	});

	test("pulumi up creates resources", async () => {
		const upRes = await pulumi(["up", "--yes"], { cwd: projectDir, pulumiHome });
		expect(upRes.exitCode).toBe(0);
		const combined = upRes.stdout + upRes.stderr;
		expect(combined).toContain("pet");
	});

	test("pulumi up + destroy lifecycle", async () => {
		const destroyRes = await pulumi(["destroy", "--yes"], { cwd: projectDir, pulumiHome });
		expect(destroyRes.exitCode).toBe(0);
	});

	test("pulumi refresh succeeds", async () => {
		const refreshDir = await newProjectDir("refresh-test");
		await Bun.write(path.join(refreshDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		try {
			const initRes = await pulumi(["stack", "init", "dev-org/update-test/refresh"], {
				cwd: refreshDir,
				pulumiHome,
			});
			expect(initRes.exitCode).toBe(0);

			const upRes = await pulumi(["up", "--yes"], { cwd: refreshDir, pulumiHome });
			expect(upRes.exitCode).toBe(0);

			const refreshRes = await pulumi(["refresh", "--yes"], { cwd: refreshDir, pulumiHome });
			expect(refreshRes.exitCode).toBe(0);
		} finally {
			await cleanupDir(refreshDir);
		}
	});

	test("pulumi up with YAML outputs", async () => {
		const outputDir = await newProjectDir("output-test");
		await Bun.write(path.join(outputDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		try {
			const initRes = await pulumi(["stack", "init", "dev-org/update-test/outputs"], {
				cwd: outputDir,
				pulumiHome,
			});
			expect(initRes.exitCode).toBe(0);

			const upRes = await pulumi(["up", "--yes"], { cwd: outputDir, pulumiHome });
			expect(upRes.exitCode).toBe(0);
			const combined = upRes.stdout + upRes.stderr;
			expect(combined).toContain("petName");
		} finally {
			await cleanupDir(outputDir);
		}
	});

	test("conflict detection rejects concurrent update", async () => {
		// Create stack via API
		await apiRequest("/stacks/dev-org/conflict-proj/conflict-stack", { method: "POST" });

		// Manually start an update to hold the lock
		const createRes = await apiRequest("/stacks/dev-org/conflict-proj/conflict-stack/update", {
			method: "POST",
			body: {},
		});
		expect(createRes.status).toBe(200);
		const { updateID } = await createRes.json();

		const startRes = await apiRequest(
			`/stacks/dev-org/conflict-proj/conflict-stack/update/${updateID}`,
			{ method: "POST", body: {} },
		);
		expect(startRes.status).toBe(200);

		// Try to run pulumi up against the locked stack — should fail
		const conflictDir = await newProjectDir("conflict-proj");
		await Bun.write(path.join(conflictDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
		try {
			await pulumi(["stack", "select", "dev-org/conflict-proj/conflict-stack"], {
				cwd: conflictDir,
				pulumiHome,
			});
			const upRes = await pulumi(["up", "--yes"], { cwd: conflictDir, pulumiHome });
			expect(upRes.exitCode).not.toBe(0);
		} finally {
			await cleanupDir(conflictDir);
			// Cancel the holding update so it doesn't leak
			await apiRequest(`/stacks/dev-org/conflict-proj/conflict-stack/update/${updateID}/cancel`, {
				method: "POST",
			});
		}
	});
});
