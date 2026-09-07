#!/usr/bin/env bun
// Verifies that supported deployment manifests carry the server bootstrap
// contract and run migrations before serving a new release.

import { BOOTSTRAP_REQUIRED_ENV_VARS } from "@procella/config";

interface ComposeMigrationContract {
	service: string;
	expectedInvocation: readonly string[];
	defaultEntrypoint?: readonly string[];
}

export interface DeploymentManifest {
	path: string;
	migrationPatterns?: readonly RegExp[];
	composeMigration?: ComposeMigrationContract;
	serverServices?: readonly string[];
	provisioningCommand?: string;
	bootstrapServices?: readonly string[];
	render?: boolean;
	sampleSecrets?: boolean;
}

export const DEPLOYMENT_MANIFESTS: readonly DeploymentManifest[] = [
	{
		path: "docker-compose.yml",
		composeMigration: {
			service: "migrate",
			expectedInvocation: [
				"bun",
				"drizzle-kit",
				"migrate",
				"--config",
				"packages/db/drizzle.config.ts",
			],
		},
		serverServices: ["procella", "procella-cluster"],
		bootstrapServices: ["procella", "procella-cluster"],
	},
	{
		path: "docker-compose.coolify.yml",
		composeMigration: {
			service: "migrate",
			defaultEntrypoint: ["/procella"],
			expectedInvocation: ["/procella", "--migrate", "/migrations"],
		},
		serverServices: ["procella"],
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

function commandParts(command: unknown): string[] | undefined {
	return Array.isArray(command) && command.every((part) => typeof part === "string")
		? command
		: undefined;
}

function checkComposeMigration(
	manifest: DeploymentManifest,
	text: string,
	problems: string[],
): void {
	const contract = manifest.composeMigration;
	if (!contract) return;
	const document = Bun.YAML.parse(text) as {
		services?: Record<
			string,
			{
				command?: unknown;
				entrypoint?: unknown;
				depends_on?: Record<string, { condition?: string }> | string[];
			}
		>;
	};
	const migration = document.services?.[contract.service];
	if (!migration) {
		problems.push(`${manifest.path}: missing migration service ${contract.service}`);
		return;
	}

	const hasEntrypointOverride = migration.entrypoint !== undefined && migration.entrypoint !== null;
	const hasCommandOverride = migration.command !== undefined && migration.command !== null;
	const configuredEntrypoint = hasEntrypointOverride
		? commandParts(migration.entrypoint)
		: [...(contract.defaultEntrypoint ?? [])];
	const configuredCommand = hasCommandOverride ? commandParts(migration.command) : [];
	if (configuredEntrypoint === undefined) {
		problems.push(`${manifest.path} -> ${contract.service}: entrypoint must use list form`);
	} else if (configuredCommand === undefined) {
		problems.push(`${manifest.path} -> ${contract.service}: command must use list form`);
	} else {
		const invocation = [...configuredEntrypoint, ...configuredCommand];
		if (invocation.join("\0") !== contract.expectedInvocation.join("\0")) {
			problems.push(
				`${manifest.path} -> ${contract.service}: expected migration invocation ${contract.expectedInvocation.join(" ")}`,
			);
		}
	}

	for (const serverName of manifest.serverServices ?? []) {
		const dependsOn = document.services?.[serverName]?.depends_on;
		const dependencies = Array.isArray(dependsOn) ? {} : (dependsOn ?? {});
		if (dependencies[contract.service]?.condition !== "service_completed_successfully") {
			problems.push(
				`${manifest.path} -> ${serverName}: must depend on ${contract.service} completing successfully`,
			);
		}
	}
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

	checkComposeMigration(manifest, text, problems);

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

function caddyHandleBody(text: string, route: string): string | undefined {
	const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const opening = new RegExp(`\\bhandle\\s+${escapedRoute}\\s*\\{`, "m").exec(text);
	if (!opening) return undefined;

	const bodyStart = opening.index + opening[0].length;
	let depth = 1;
	for (let index = bodyStart; index < text.length; index++) {
		if (text[index] === "{") depth++;
		if (text[index] !== "}") continue;
		depth--;
		if (depth === 0) return text.slice(bodyStart, index);
	}
	return undefined;
}

export function checkProxyConfig(text: string): string[] {
	const active = activeText(text);
	const backend = /\breverse_proxy\s+procella-cluster:9090\b/;
	return ["/api/*", "/trpc/*", "/healthz", "/github/setup"].flatMap((route) => {
		const body = caddyHandleBody(active, route);
		return body && backend.test(body) ? [] : [`Caddyfile: invalid server route ${route}`];
	});
}

/**
 * GitHub user authorization runs through a Descope Outbound App, so the GitHub
 * OAuth client credentials must never reach a runtime environment. They are
 * allowed only as deploy-time inputs to the outbound-app provisioning command.
 */
export const RUNTIME_FORBIDDEN_ENV_VARS = [
	"PROCELLA_GITHUB_APP_CLIENT_ID",
	"PROCELLA_GITHUB_APP_CLIENT_SECRET",
] as const;

/** Only the Descope provisioning command may pass the OAuth client credentials. */
const PROVISIONING_ENV_FILES: Record<string, true> = { "infra/descope.ts": true };

export function checkRuntimeEnvironment(path: string, text: string): string[] {
	if (PROVISIONING_ENV_FILES[path]) return [];
	// Manifests comment with `#`, TypeScript infra files with `//`. A commented
	// mention documents the deploy-time rule; it does not configure a runtime.
	const active = activeText(text)
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n");
	return RUNTIME_FORBIDDEN_ENV_VARS.filter((envVar) => active.includes(envVar)).map(
		(envVar) => `${path}: ${envVar} must not reach runtime configuration`,
	);
}

/** Files whose active text is scanned for credentials that must stay deploy-time. */
export const RUNTIME_ENV_FILES = [
	"infra/secrets.ts",
	"infra/api.ts",
	"infra/web-api.ts",
	"infra/gc.ts",
	"docker-compose.yml",
	"docker-compose.coolify.yml",
	"render.yaml",
	"railway.toml",
	"fly.toml",
	".env.example",
] as const;

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
	for (const path of RUNTIME_ENV_FILES) {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			problems.push(`${path}: runtime environment file is missing`);
			continue;
		}
		problems.push(...checkRuntimeEnvironment(path, await file.text()));
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
