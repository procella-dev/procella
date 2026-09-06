#!/usr/bin/env bun
// Verifies that supported deployment manifests carry the server bootstrap
// contract and run migrations before serving a new release.

import { BOOTSTRAP_REQUIRED_ENV_VARS } from "@procella/config";

export interface DeploymentManifest {
	path: string;
	migrationPatterns?: readonly RegExp[];
	render?: boolean;
}

const MIGRATE_COMMAND = /(?:--migrate|drizzle-kit["',\s]+migrate)/;
const COMPLETED_MIGRATION = /migrate:\s*\n\s*condition:\s*service_completed_successfully/;

export const DEPLOYMENT_MANIFESTS: readonly DeploymentManifest[] = [
	{ path: "docker-compose.yml", migrationPatterns: [MIGRATE_COMMAND, COMPLETED_MIGRATION] },
	{
		path: "docker-compose.coolify.yml",
		migrationPatterns: [MIGRATE_COMMAND, COMPLETED_MIGRATION],
	},
	{
		path: "render.yaml",
		migrationPatterns: [/preDeployCommand:.*--migrate/],
		render: true,
	},
	{ path: "railway.toml", migrationPatterns: [/preDeployCommand\s*=.*--migrate/] },
	{ path: "fly.toml", migrationPatterns: [/release_command\s*=.*--migrate/] },
	{ path: ".env.example" },
];

export function checkManifest(manifest: DeploymentManifest, text: string): string[] {
	const problems: string[] = [];
	for (const envVar of BOOTSTRAP_REQUIRED_ENV_VARS) {
		if (!new RegExp(`\\b${envVar}\\b`).test(text)) {
			problems.push(`${manifest.path}: missing ${envVar}`);
		}
	}
	for (const pattern of manifest.migrationPatterns ?? []) {
		if (!pattern.test(text)) {
			problems.push(`${manifest.path}: missing migration startup gate (${pattern.source})`);
		}
	}

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
	return problems;
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
