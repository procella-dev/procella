import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationOperations, migrateOne } from "../packages/migrate/src/migrate.js";
import { createStack, exportState } from "../packages/migrate/src/procella.js";
import type { RunOptions, UntypedDeployment } from "../packages/migrate/src/types.js";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	pulumi,
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

test("H5 migration stores secrets as target-provider ciphertext", async () => {
	const pulumiHome = await createPulumiHome();
	const outputDir = await mkdtemp(join(tmpdir(), "procella-h5-migration-"));
	const project = `h5-${randomUUID().slice(0, 8)}`;
	const seedStack = `seed-${randomUUID().slice(0, 8)}`;
	const targetStack = `target-${randomUUID().slice(0, 8)}`;
	const targetFqn = `dev-org/${project}/${targetStack}`;
	const secretValues = Array.from({ length: 4 }, () => `secret-${randomUUID()}`);

	try {
		const login = await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });
		expect(login.exitCode).toBe(0);

		const seedCreate = await apiRequest(`/stacks/dev-org/${project}/${seedStack}`, {
			method: "POST",
		});
		expect(seedCreate.status).toBe(200);
		const seedExport = await apiRequest(`/stacks/dev-org/${project}/${seedStack}/export`);
		expect(seedExport.status).toBe(200);
		const sourceDeployment = (await seedExport.json()) as UntypedDeployment;
		sourceDeployment.deployment.secrets_providers = {
			type: "passphrase",
			state: { salt: `source-${randomUUID()}` },
		};
		sourceDeployment.deployment.resources = [
			{
				urn: `urn:pulumi:${targetStack}::${project}::pulumi:pulumi:Stack::${project}-${targetStack}`,
				type: "pulumi:pulumi:Stack",
				custom: false,
				inputs: {
					database: plaintextSecret(secretValues[0]),
					nested: {
						credentials: [plaintextSecret(secretValues[1]), plaintextSecret(secretValues[2])],
					},
				},
				outputs: { signingKey: plaintextSecret(secretValues[3]) },
			},
		];

		const operations: MigrationOperations = {
			exportStack: async (_stackFqn, filePath) => {
				await writeFile(filePath, JSON.stringify(sourceDeployment));
			},
			createStack,
			importStack: async (stackFqn, filePath) => {
				const imported = await pulumi(
					["stack", "import", "--force", "--stack", stackFqn, "--file", filePath],
					{ pulumiHome },
				);
				if (imported.exitCode !== 0) {
					throw new Error(`pulumi stack import failed: ${imported.stderr}`);
				}
			},
			exportState,
		};
		const options: RunOptions = {
			sourceUrl: `file://${join(outputDir, "source")}`,
			sourceToken: randomUUID(),
			targetUrl: `${BACKEND_URL}/`,
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
				fqn: targetFqn,
				ref: { org: "dev-org", project, stack: targetStack },
				resourceCount: 1,
				lastUpdate: null,
			},
			1,
			1,
			options,
			operations,
		);
		expect(result.status).toBe("succeeded");

		const targetExport = await apiRequest(`/stacks/dev-org/${project}/${targetStack}/export`);
		expect(targetExport.status).toBe(200);
		const targetDeployment = (await targetExport.json()) as UntypedDeployment;
		expect(targetDeployment.deployment.secrets_providers).toEqual({
			type: "service",
			state: {
				url: BACKEND_URL,
				owner: "dev-org",
				project,
				stack: targetStack,
			},
		});
		const serializedTarget = JSON.stringify(targetDeployment);
		expect(serializedTarget).not.toContain('"plaintext"');
		for (const secretValue of secretValues) {
			expect(serializedTarget).not.toContain(secretValue);
		}
		expect(serializedTarget.match(/"ciphertext"/g)).toHaveLength(secretValues.length);
	} finally {
		await cleanupDir(pulumiHome);
		await rm(outputDir, { recursive: true, force: true });
		await truncateTables();
	}
});
