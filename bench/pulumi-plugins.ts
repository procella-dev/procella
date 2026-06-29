import { existsSync } from "node:fs";
import path from "node:path";

export interface PulumiPluginSpec {
	kind: "resource" | "language" | "analyzer";
	name: string;
	version: string;
	server?: string;
}

export const BENCH_REQUIRED_PLUGINS: readonly PulumiPluginSpec[] = [
	{
		kind: "resource",
		name: "random",
		version: "4.19.2",
		server: "https://get.pulumi.com/releases/plugins",
	},
] as const;

export function pulumiPluginDirectoryName(plugin: PulumiPluginSpec): string {
	return `${plugin.kind}-${plugin.name}-v${plugin.version}`;
}

export function pulumiPluginInstallArgs(plugin: PulumiPluginSpec): string[] {
	const args = ["plugin", "install", plugin.kind, plugin.name, plugin.version];
	if (plugin.server) {
		args.push("--server", plugin.server);
	}
	return args;
}

export function missingPulumiPlugins(
	pulumiHome: string,
	plugins: readonly PulumiPluginSpec[] = BENCH_REQUIRED_PLUGINS,
): PulumiPluginSpec[] {
	return plugins.filter(
		(plugin) => !existsSync(path.join(pulumiHome, "plugins", pulumiPluginDirectoryName(plugin))),
	);
}
