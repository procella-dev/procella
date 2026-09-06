import { describe, expect, test } from "bun:test";
import { getDirectNeonMigrationUrl, releaseMigrationLock } from "./migration-lock.js";

describe("migration advisory lock", () => {
	test("uses a direct Neon endpoint for session-affine locking", () => {
		expect(
			getDirectNeonMigrationUrl(
				"postgresql://user:password@ep-example-pooler.us-east-2.aws.neon.tech/procella?sslmode=require",
			),
		).toBe(
			"postgresql://user:password@ep-example.us-east-2.aws.neon.tech/procella?sslmode=require",
		);
		expect(
			getDirectNeonMigrationUrl(
				"postgresql://user:password@ep-example.us-east-2.aws.neon.tech/procella?sslmode=require",
			),
		).toBe(
			"postgresql://user:password@ep-example.us-east-2.aws.neon.tech/procella?sslmode=require",
		);
	});

	test("suppresses unlock errors and always releases the connection", async () => {
		let released = false;

		await releaseMigrationLock(
			true,
			async () => {
				throw new Error("connection lost during unlock");
			},
			() => {
				released = true;
			},
		);

		expect(released).toBe(true);
	});
});
