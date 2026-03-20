// E2E — Journaling protocol: pulumi up/destroy with PULUMI_DISABLE_JOURNALING unset (journaling on).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import {
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

	test("pulumi up succeeds with journaling enabled (default)", async () => {
		projectDir = await newProjectDir("journaling-test");
		await Bun.write(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);

		const initRes = await pulumi(["stack", "init", "dev-org/journaling-test/dev"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(initRes.exitCode).toBe(0);

		const upRes = await pulumi(["up", "--yes"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(upRes.exitCode).toBe(0);
		const combined = upRes.stdout + upRes.stderr;
		expect(combined).toContain("pet");
	});

	test("pulumi destroy succeeds with journaling enabled", async () => {
		const destroyRes = await pulumi(["destroy", "--yes"], {
			cwd: projectDir,
			pulumiHome,
		});
		if (destroyRes.exitCode !== 0) {
			console.error("destroy stderr:", destroyRes.stderr);
			console.error("destroy stdout:", destroyRes.stdout);
		}
		expect(destroyRes.exitCode).toBe(0);
	});

	test("pulumi up succeeds with journaling explicitly disabled (fallback to checkpoint)", async () => {
		const upRes = await pulumi(["up", "--yes"], {
			cwd: projectDir,
			pulumiHome,
			env: { PULUMI_DISABLE_JOURNALING: "true" },
		});
		if (upRes.exitCode !== 0) {
			console.error("up(disabled) stderr:", upRes.stderr);
			console.error("up(disabled) stdout:", upRes.stdout);
		}
		expect(upRes.exitCode).toBe(0);

		await pulumi(["destroy", "--yes"], {
			cwd: projectDir,
			pulumiHome,
			env: { PULUMI_DISABLE_JOURNALING: "true" },
		});
	});
});
