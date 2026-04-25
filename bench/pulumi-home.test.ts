import { describe, expect, mock, test } from "bun:test";
import { preparePulumiHome } from "./pulumi-home";

describe("preparePulumiHome", () => {
	test("returns the home path when plugin installation succeeds", async () => {
		const createPulumiHome = mock(async () => "/tmp/pulumi-home");
		const ensurePulumiPlugins = mock(async () => {});
		const cleanupPulumiHome = mock(async () => {});

		await expect(
			preparePulumiHome({ createPulumiHome, ensurePulumiPlugins, cleanupPulumiHome }),
		).resolves.toBe("/tmp/pulumi-home");
		expect(cleanupPulumiHome).not.toHaveBeenCalled();
	});

	test("cleans up the temporary home when plugin installation fails", async () => {
		const createPulumiHome = mock(async () => "/tmp/pulumi-home");
		const ensurePulumiPlugins = mock(async () => {
			throw new Error("plugin install failed");
		});
		const cleanupPulumiHome = mock(async () => {});

		await expect(
			preparePulumiHome({ createPulumiHome, ensurePulumiPlugins, cleanupPulumiHome }),
		).rejects.toThrow("plugin install failed");
		expect(cleanupPulumiHome).toHaveBeenCalledWith("/tmp/pulumi-home");
	});

	test("preserves the original plugin error if cleanup also fails", async () => {
		const createPulumiHome = mock(async () => "/tmp/pulumi-home");
		const ensurePulumiPlugins = mock(async () => {
			throw new Error("plugin install failed");
		});
		const cleanupPulumiHome = mock(async () => {
			throw new Error("cleanup failed");
		});

		await expect(
			preparePulumiHome({ createPulumiHome, ensurePulumiPlugins, cleanupPulumiHome }),
		).rejects.toMatchObject({
			message: "Failed to prepare Pulumi home /tmp/pulumi-home and clean it up",
			errors: [expect.objectContaining({ message: "plugin install failed" }), expect.objectContaining({ message: "cleanup failed" })],
		});
	});
});
