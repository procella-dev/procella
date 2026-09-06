import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationOperations, migrateOne } from "../packages/migrate/src/migrate.js";
import {
	batchDecrypt,
	createStack,
	exportState,
	getCallerOrg,
} from "../packages/migrate/src/procella.js";
import { importStack } from "../packages/migrate/src/pulumi.js";
import type { RunOptions, UntypedDeployment } from "../packages/migrate/src/types.js";
import { type ValidationOperations, validate } from "../packages/migrate/src/validate.js";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	TEST_TOKEN,
	truncateTables,
} from "./helpers.js";

const secretSignatureKey = "4dabf18193072939515e22adb298388d";
const secretSignature = "1b47061264138c4ac30d75fd1eb44270";

function plaintextSecret(value: string): Record<string, string> {
	return {
		[secretSignatureKey]: secretSignature,
		plaintext: JSON.stringify(value),
	};
}

/**
 * M2b: migrateOne's post-import verification used to compare resource *counts* only, and
 * standalone validate() compared resource *URN sets* only. Both certified a same-count/
 * same-URN target with corrupted content as a successful migration. These tests exercise
 * the fix — the canonical `compareDeploymentState` comparator — against the real Procella
 * server and the real `pulumi` CLI, extending H5's secret-provider round trip.
 *
 * Procella scopes a stack's identity to the authenticated tenant, not the source org path
 * segment (see destination.ts). A source stack discovered as `legacy-cloud/{project}/{stack}`
 * therefore migrates to `dev-org/{project}/{stack}` — the *same* project/stack name, only
 * the org differs — matching real migration behavior (migrateOne never renames a stack).
 */
async function withMigratedStack(
	run: (ctx: {
		project: string;
		stack: string;
		sourceDeployment: UntypedDeployment;
		options: RunOptions;
	}) => Promise<void>,
): Promise<void> {
	const pulumiHome = await createPulumiHome();
	const outputDir = await mkdtemp(join(tmpdir(), "procella-m2b-migration-"));
	const project = `m2b-${randomUUID().slice(0, 8)}`;
	const stack = `seed-${randomUUID().slice(0, 8)}`;
	const secretValue = `secret-${randomUUID()}`;
	const previousPulumiHome = process.env.PULUMI_HOME;
	process.env.PULUMI_HOME = pulumiHome;

	try {
		const seedCreate = await apiRequest(`/stacks/dev-org/${project}/${stack}`, { method: "POST" });
		expect(seedCreate.status).toBe(200);
		const seedExport = await apiRequest(`/stacks/dev-org/${project}/${stack}/export`);
		expect(seedExport.status).toBe(200);
		const sourceDeployment = (await seedExport.json()) as UntypedDeployment;
		sourceDeployment.deployment.secrets_providers = {
			type: "passphrase",
			state: { salt: randomUUID() },
		};
		sourceDeployment.deployment.resources = [
			{
				urn: `urn:pulumi:${stack}::${project}::pulumi:pulumi:Stack::${project}-${stack}`,
				type: "pulumi:pulumi:Stack",
				inputs: { region: "us-east-1" },
				outputs: {
					endpoint: "https://api.example.test",
					password: plaintextSecret(secretValue),
				},
				dependencies: [],
			},
		];

		const operations: MigrationOperations = {
			exportStack: async (_fqn, filePath) => {
				await writeFile(filePath, JSON.stringify(sourceDeployment));
			},
			createStack,
			importStack,
			exportState,
			batchDecrypt,
			getCallerOrg,
		};
		const options: RunOptions = {
			sourceUrl: BACKEND_URL,
			sourceToken: TEST_TOKEN,
			targetUrl: BACKEND_URL,
			targetToken: TEST_TOKEN,
			filter: "*",
			exclude: "",
			dryRun: false,
			concurrency: 1,
			continueOnError: false,
			keepExports: false,
			outputDir,
		};

		const result = await migrateOne(
			{
				fqn: `legacy-cloud/${project}/${stack}`,
				ref: { org: "legacy-cloud", project, stack },
				resourceCount: 1,
				lastUpdate: null,
			},
			1,
			1,
			options,
			operations,
		);
		expect(result.status).toBe("succeeded");

		await run({ project, stack, sourceDeployment, options });
	} finally {
		if (previousPulumiHome === undefined) delete process.env.PULUMI_HOME;
		else process.env.PULUMI_HOME = previousPulumiHome;
		await cleanupDir(pulumiHome);
		await rm(outputDir, { recursive: true, force: true });
		await truncateTables();
	}
}

/** Discriminate source vs target discovery by token — both sides share one backend URL here. */
const VALIDATE_SOURCE_TOKEN = "validate-source-marker";

function validationOpsFor(
	project: string,
	stack: string,
	sourceDeployment: UntypedDeployment,
): ValidationOperations {
	return {
		discoverStacks: async (_url: string, token: string) =>
			token === VALIDATE_SOURCE_TOKEN
				? [
						{
							fqn: `legacy-cloud/${project}/${stack}`,
							ref: { org: "legacy-cloud", project, stack },
							resourceCount: 1,
							lastUpdate: null,
						},
					]
				: [
						{
							fqn: `dev-org/${project}/${stack}`,
							ref: { org: "dev-org", project, stack },
							resourceCount: 1,
							lastUpdate: null,
						},
					],
		exportFromBackend: async () => sourceDeployment,
		exportState,
		batchDecrypt,
	};
}

test("M2b: real migration round trip passes deep verification and validate() reports a match", async () => {
	await withMigratedStack(async ({ project, stack, sourceDeployment, options }) => {
		const [validation] = await validate(
			{
				sourceUrl: options.sourceUrl,
				sourceToken: VALIDATE_SOURCE_TOKEN,
				targetUrl: options.targetUrl,
				targetToken: options.targetToken,
				filter: "*",
				exclude: "",
			},
			validationOpsFor(project, stack, sourceDeployment),
		);

		expect(validation.status).toBe("match");
		expect(validation.mismatches).toEqual([]);
	});
});

test("M2b: validate() rejects a target whose state drifted after migration", async () => {
	await withMigratedStack(async ({ project, stack, sourceDeployment, options }) => {
		// Simulate drift: something re-imports a corrupted checkpoint directly into the
		// target stack after migration (e.g. a manual repair gone wrong).
		const corrupted: UntypedDeployment = JSON.parse(JSON.stringify(sourceDeployment));
		corrupted.deployment.secrets_providers = {
			type: "service",
			state: { url: options.targetUrl, owner: "dev-org", project, stack },
		};
		corrupted.deployment.resources = [
			{
				...(corrupted.deployment.resources ?? [])[0],
				outputs: { endpoint: "https://drifted.example.test" },
			},
		];
		const reimport = await apiRequest(`/stacks/dev-org/${project}/${stack}/import`, {
			method: "POST",
			body: corrupted,
		});
		expect(reimport.status).toBe(200);

		const [validation] = await validate(
			{
				sourceUrl: options.sourceUrl,
				sourceToken: VALIDATE_SOURCE_TOKEN,
				targetUrl: options.targetUrl,
				targetToken: options.targetToken,
				filter: "*",
				exclude: "",
			},
			validationOpsFor(project, stack, sourceDeployment),
		);

		expect(validation.status).toBe("mismatch");
		expect(validation.error).toContain("outputs.endpoint");
	});
});
