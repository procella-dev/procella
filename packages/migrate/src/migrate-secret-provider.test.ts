import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasPlaintextSecret, type MigrationOperations, migrateOne } from "./migrate.js";
import * as pulumi from "./pulumi.js";
import type { RunOptions, UntypedDeployment } from "./types.js";

const secretSignatureKey = "4dabf18193072939515e22adb298388d";
const secretSignature = "1b47061264138c4ac30d75fd1eb44270";

function plaintextSecret(value: string): Record<string, string> {
	return {
		[secretSignatureKey]: secretSignature,
		plaintext: JSON.stringify(value),
	};
}

function ciphertextSecret(value: string): Record<string, string> {
	return {
		[secretSignatureKey]: secretSignature,
		ciphertext: Buffer.from(JSON.stringify(value)).toString("base64"),
	};
}

function deploymentWithSecrets(
	secrets: Array<Record<string, string>>,
	provider: UntypedDeployment["deployment"]["secrets_providers"],
): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			secrets_providers: provider,
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					inputs: {
						database: secrets[0],
						nested: { credentials: [secrets[1], secrets[2]] },
					},
					outputs: { signingKey: secrets[3] },
				},
			],
		},
	};
}

test("migrateOne routes plaintext exports through the normalized target import", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "procella-migrate-secret-provider-"));
	const binDir = join(tempDir, "bin");
	const capturedImportFile = join(tempDir, "captured-import.json");
	const targetUrl = "https://target.example.test";
	const targetToken = randomUUID();
	const secretValues = Array.from({ length: 4 }, () => `secret-${randomUUID()}`);
	const sourceDeployment = deploymentWithSecrets(secretValues.map(plaintextSecret), {
		type: "passphrase",
		state: { salt: "generated-source-provider-state" },
	});
	const targetDeployment = deploymentWithSecrets(secretValues.map(ciphertextSecret), {
		type: "service",
		state: { url: targetUrl, owner: "target-org", project: "api", stack: "prod" },
	});

	const fakePulumi = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const stackIndex = args.indexOf("--stack");
if (args[0] !== "--non-interactive" || args[1] !== "stack" || args[2] !== "import" || !args.includes("--force")) process.exit(11);
if (args[stackIndex + 1] !== "target-org/api/prod") process.exit(12);
if (process.env.PULUMI_BACKEND_URL !== process.env.EXPECTED_TARGET_BACKEND) process.exit(13);
if (process.env.PULUMI_ACCESS_TOKEN !== process.env.EXPECTED_TARGET_TOKEN) process.exit(14);
fs.copyFileSync(args[fileIndex + 1], process.env.CAPTURED_IMPORT_FILE);
`;

	await mkdir(binDir);
	const pulumiPath = join(binDir, "pulumi");
	await writeFile(pulumiPath, fakePulumi);
	await chmod(pulumiPath, 0o755);

	const previousPath = process.env.PATH;
	const previousCapturedImportFile = process.env.CAPTURED_IMPORT_FILE;
	const previousExpectedBackend = process.env.EXPECTED_TARGET_BACKEND;
	const previousExpectedToken = process.env.EXPECTED_TARGET_TOKEN;
	process.env.PATH = `${binDir}:${previousPath ?? ""}`;
	process.env.CAPTURED_IMPORT_FILE = capturedImportFile;
	process.env.EXPECTED_TARGET_BACKEND = targetUrl;
	process.env.EXPECTED_TARGET_TOKEN = targetToken;

	try {
		const operations: MigrationOperations = {
			exportStack: async (_stackFqn, filePath, options) => {
				expect(options).toEqual({
					backendUrl: "https://source.example.test",
					token: expect.any(String),
				});
				await writeFile(filePath, JSON.stringify(sourceDeployment));
			},
			createStack: async (options, org, project, stack) => {
				expect(options).toEqual({ url: targetUrl, token: targetToken });
				expect([org, project, stack]).toEqual(["target-org", "api", "prod"]);
				return { created: true };
			},
			importStack: pulumi.importStack,
			exportState: async (options) => {
				expect(options).toEqual({ url: targetUrl, token: targetToken });
				return targetDeployment;
			},
		};
		const options: RunOptions = {
			sourceUrl: "https://source.example.test",
			sourceToken: randomUUID(),
			targetUrl: `${targetUrl}/`,
			targetToken,
			filter: "*",
			exclude: "",
			dryRun: false,
			concurrency: 1,
			continueOnError: false,
			keepExports: true,
			outputDir: join(tempDir, "exports"),
		};

		const result = await migrateOne(
			{
				fqn: "target-org/api/prod",
				ref: { org: "target-org", project: "api", stack: "prod" },
				resourceCount: 1,
				lastUpdate: null,
			},
			1,
			1,
			options,
			operations,
		);

		expect(result.status).toBe("succeeded");
		const importDeployment = JSON.parse(await readFile(capturedImportFile, "utf8"));
		expect(importDeployment.deployment.secrets_providers).toEqual({
			type: "service",
			state: { url: targetUrl, owner: "target-org", project: "api", stack: "prod" },
		});
		expect(hasPlaintextSecret(importDeployment)).toBe(true);
		expect(JSON.parse(await readFile(result.exportFile ?? "", "utf8"))).toEqual(sourceDeployment);
		expect(
			await Bun.file(join(options.outputDir, "target-org/api/prod.import.json")).exists(),
		).toBe(false);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCapturedImportFile === undefined) delete process.env.CAPTURED_IMPORT_FILE;
		else process.env.CAPTURED_IMPORT_FILE = previousCapturedImportFile;
		if (previousExpectedBackend === undefined) delete process.env.EXPECTED_TARGET_BACKEND;
		else process.env.EXPECTED_TARGET_BACKEND = previousExpectedBackend;
		if (previousExpectedToken === undefined) delete process.env.EXPECTED_TARGET_TOKEN;
		else process.env.EXPECTED_TARGET_TOKEN = previousExpectedToken;
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("hasPlaintextSecret detects only signed Pulumi plaintext envelopes", () => {
	expect(hasPlaintextSecret({ nested: [plaintextSecret(randomUUID())] })).toBe(true);
	expect(hasPlaintextSecret({ plaintext: randomUUID() })).toBe(false);
	expect(hasPlaintextSecret(ciphertextSecret(randomUUID()))).toBe(false);
});
