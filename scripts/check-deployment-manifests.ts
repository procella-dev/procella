#!/usr/bin/env bun
// Verifies that supported deployment manifests carry the server bootstrap
// contract and run migrations before serving a new release.

import { BOOTSTRAP_REQUIRED_ENV_VARS } from "@procella/config";

export interface DeploymentManifest {
	path: string;
	migrationPatterns?: readonly RegExp[];
	provisioningCommand?: string;
	bootstrapServices?: readonly string[];
	render?: boolean;
	sampleSecrets?: boolean;
}

const MIGRATE_COMMAND = /(?:--migrate|drizzle-kit["',\s]+migrate)/;
const COMPLETED_MIGRATION = /migrate:\s*\n\s*condition:\s*service_completed_successfully/;

export const DEPLOYMENT_MANIFESTS: readonly DeploymentManifest[] = [
	{
		path: "docker-compose.yml",
		migrationPatterns: [MIGRATE_COMMAND, COMPLETED_MIGRATION],
		bootstrapServices: ["procella", "procella-cluster"],
	},
	{
		path: "docker-compose.coolify.yml",
		migrationPatterns: [MIGRATE_COMMAND, COMPLETED_MIGRATION],
		bootstrapServices: ["procella", "migrate"],
	},
	{
		path: "render.yaml",
		migrationPatterns: [/preDeployCommand:.*--migrate/],
		render: true,
	},
	{
		path: "railway.toml",
		migrationPatterns: [/preDeployCommand\s*=.*--migrate/],
		provisioningCommand: "railway variables --set",
	},
	{
		path: "fly.toml",
		migrationPatterns: [/release_command\s*=.*--migrate/],
		provisioningCommand: "fly secrets set",
	},
	{ path: ".env.example", sampleSecrets: true },
];

function activeText(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

function hasActiveDeclaration(text: string, envVar: string): boolean {
	return new RegExp(`^\\s*(?:-\\s+key:\\s*${envVar}(?:\\s+#.*)?|${envVar}\\s*[:=])`, "m").test(
		activeText(text),
	);
}

function hasProvisioningCommand(text: string, command: string, envVar: string): boolean {
	return text.split("\n").some((line) => {
		if (!/^\s*#/.test(line)) return false;
		return line.includes(command) && new RegExp(`\\b${envVar}\\b`).test(line);
	});
}

function environmentNames(environment: unknown): Set<string> {
	if (Array.isArray(environment)) {
		return new Set(
			environment
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.split(/[=:]/, 1)[0]?.trim())
				.filter((value): value is string => Boolean(value)),
		);
	}
	if (typeof environment === "object" && environment !== null) {
		return new Set(Object.keys(environment));
	}
	return new Set();
}

function checkBootstrapServices(
	manifest: DeploymentManifest,
	text: string,
	problems: string[],
): void {
	if (!manifest.bootstrapServices) return;
	const document = Bun.YAML.parse(text) as {
		services?: Record<string, { environment?: unknown }>;
	};
	for (const serviceName of manifest.bootstrapServices) {
		const service = document.services?.[serviceName];
		if (!service) {
			problems.push(`${manifest.path}: missing bootstrap service ${serviceName}`);
			continue;
		}
		const names = environmentNames(service.environment);
		for (const envVar of BOOTSTRAP_REQUIRED_ENV_VARS) {
			if (!names.has(envVar)) {
				problems.push(`${manifest.path} -> ${serviceName}: missing ${envVar}`);
			}
		}
	}
}

export function checkManifest(manifest: DeploymentManifest, text: string): string[] {
	const problems: string[] = [];
	for (const envVar of BOOTSTRAP_REQUIRED_ENV_VARS) {
		const declared =
			hasActiveDeclaration(text, envVar) ||
			Boolean(
				manifest.provisioningCommand &&
					hasProvisioningCommand(text, manifest.provisioningCommand, envVar),
			);
		if (!declared) problems.push(`${manifest.path}: missing ${envVar}`);
	}

	const uncommented = activeText(text);
	for (const pattern of manifest.migrationPatterns ?? []) {
		if (!pattern.test(uncommented)) {
			problems.push(`${manifest.path}: missing migration startup gate (${pattern.source})`);
		}
	}

	checkBootstrapServices(manifest, text, problems);

	if (manifest.render) {
		const document = Bun.YAML.parse(text) as {
			envVarGroups?: { name?: string; envVars?: { key?: string; sync?: boolean }[] }[];
		};
		for (const group of document.envVarGroups ?? []) {
			for (const envVar of group.envVars ?? []) {
				if (envVar.sync === false) {
					problems.push(
						`${manifest.path}: ${envVar.key ?? "unnamed env var"} uses unsupported sync: false in envVarGroups.${group.name ?? "unnamed"}`,
					);
				}
			}
		}
	}

	if (manifest.sampleSecrets) {
		const sample = /^\s*PROCELLA_TICKET_SIGNING_KEY\s*=\s*(.*)$/m.exec(uncommented)?.[1]?.trim();
		if (sample && sample.length >= 32) {
			problems.push(`${manifest.path}: ticket-signing placeholder passes runtime validation`);
		}
	}
	return problems;
}

export function checkProxyConfig(text: string): string[] {
	return ["/api/*", "/trpc/*", "/healthz", "/github/setup", "/cron/gc"]
		.filter((route) => !text.includes(route))
		.map((route) => `Caddyfile: missing server route ${route}`);
}

export async function checkDeploymentManifests(): Promise<string[]> {
	const problems: string[] = [];
	for (const manifest of DEPLOYMENT_MANIFESTS) {
		const file = Bun.file(manifest.path);
		if (!(await file.exists())) {
			problems.push(`${manifest.path}: manifest is missing`);
			continue;
		}
		problems.push(...checkManifest(manifest, await file.text()));
	}
	problems.push(...checkProxyConfig(await Bun.file("Caddyfile").text()));
	return problems;
}

if (import.meta.main) {
	const problems = await checkDeploymentManifests();
	if (problems.length > 0) {
		console.error(`Deployment manifest check FAILED (${problems.length} issue(s)):`);
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log(`Deployment manifest check passed (${DEPLOYMENT_MANIFESTS.length} manifests).`);
}
