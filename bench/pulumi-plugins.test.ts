import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	BENCH_REQUIRED_PLUGINS,
	missingPulumiPlugins,
	pulumiPluginDirectoryName,
	pulumiPluginInstallArgs,
} from "./pulumi-plugins";

const tempDirs: string[] = [];

async function createPulumiHome(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "procella-bench-plugins-"));
	tempDirs.push(dir);
	await mkdir(path.join(dir, "plugins"), { recursive: true });
	return dir;
}

describe("missingPulumiPlugins", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test("returns the pinned random plugin when it is missing", async () => {
		const pulumiHome = await createPulumiHome();

		expect(missingPulumiPlugins(pulumiHome)).toEqual(BENCH_REQUIRED_PLUGINS);
	});

	test("skips plugins that are already present in the Pulumi home", async () => {
		const pulumiHome = await createPulumiHome();
		const plugin = BENCH_REQUIRED_PLUGINS[0];
		if (!plugin) throw new Error("expected a required benchmark plugin");

		await mkdir(path.join(pulumiHome, "plugins", pulumiPluginDirectoryName(plugin)), {
			recursive: true,
		});

		expect(missingPulumiPlugins(pulumiHome)).toEqual([]);
	});
});

describe("pulumiPluginInstallArgs", () => {
	test("pins the plugin version and uses the Pulumi plugin server", () => {
		const plugin = BENCH_REQUIRED_PLUGINS[0];
		if (!plugin) throw new Error("expected a required benchmark plugin");

		expect(pulumiPluginInstallArgs(plugin)).toEqual([
			"plugin",
			"install",
			"resource",
			"random",
			"4.19.2",
			"--server",
			"https://get.pulumi.com/releases/plugins",
		]);
	});
});
