// E2E — Pulumi CLI login and whoami against the running server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BACKEND_URL, cleanupDir, createPulumiHome, pulumi, truncateTables } from "./helpers.js";

describe("login", () => {
	let pulumiHome: string;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
	});

	afterAll(async () => {
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("pulumi login succeeds", async () => {
		const res = await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
		expect(res.exitCode).toBe(0);
		const combined = res.stdout + res.stderr;
		expect(combined).toContain("Logged in");
	});

	test("pulumi whoami returns user", async () => {
		const res = await pulumi(["whoami"], { pulumiHome });
		expect(res.exitCode).toBe(0);
		expect(res.stdout.trim().length).toBeGreaterThan(0);
	});

	test("pulumi login with bad token is rejected", async () => {
		const badHome = await createPulumiHome();
		try {
			const res = await pulumi(["login", "--cloud-url", BACKEND_URL], {
				pulumiHome: badHome,
				env: { PULUMI_ACCESS_TOKEN: "bad-token-xxx" },
			});
			expect(res.exitCode).not.toBe(0);
		} finally {
			await cleanupDir(badHome);
		}
	});
});
