import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationOperations, migrateOne } from "./migrate.js";
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

test("migrateOne reserializes plaintext secrets with the target service provider", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "procella-migrate-secret-provider-"));
	const binDir = join(tempDir, "bin");
	const targetStateFile = join(tempDir, "target-state.json");
	const targetUrl = "https://target.example.test";
	const targetToken = randomUUID();
	const secretValues = Array.from({ length: 4 }, () => `secret-${randomUUID()}`);
	const sourceDeployment: UntypedDeployment = {
		version: 3,
		deployment: {
			secrets_providers: {
				type: "passphrase",
				state: { salt: "generated-source-provider-state" },
			},
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					inputs: {
						database: plaintextSecret(secretValues[0]),
						nested: {
							credentials: [plaintextSecret(secretValues[1]), plaintextSecret(secretValues[2])],
						},
					},
					outputs: { signingKey: plaintextSecret(secretValues[3]) },
				},
			],
		},
	};

	const fakePulumi = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const stackIndex = args.indexOf("--stack");
if (args[0] !== "--non-interactive" || args[1] !== "stack" || args[2] !== "import" || !args.includes("--force")) process.exit(11);
if (args[stackIndex + 1] !== "target-org/api/prod") process.exit(12);
if (process.env.PULUMI_BACKEND_URL !== process.env.EXPECTED_TARGET_BACKEND) process.exit(13);
if (process.env.PULUMI_ACCESS_TOKEN !== process.env.EXPECTED_TARGET_TOKEN) process.exit(14);
const deployment = JSON.parse(fs.readFileSync(args[fileIndex + 1], "utf8"));
const encrypt = (value) => {
  if (Array.isArray(value)) return value.map(encrypt);
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "plaintext")) {
      const { plaintext, ...secret } = value;
      return { ...secret, ciphertext: Buffer.from(plaintext).toString("base64") };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encrypt(entry)]));
  }
  return value;
};
fs.writeFileSync(process.env.TARGET_STATE_FILE, JSON.stringify(encrypt(deployment)));
`;

	await mkdir(binDir);
	const pulumiPath = join(binDir, "pulumi");
	await writeFile(pulumiPath, fakePulumi);
	await chmod(pulumiPath, 0o755);

	const previousPath = process.env.PATH;
	const previousTargetStateFile = process.env.TARGET_STATE_FILE;
	const previousExpectedBackend = process.env.EXPECTED_TARGET_BACKEND;
	const previousExpectedToken = process.env.EXPECTED_TARGET_TOKEN;
	process.env.PATH = `${binDir}:${previousPath ?? ""}`;
	process.env.TARGET_STATE_FILE = targetStateFile;
	process.env.EXPECTED_TARGET_BACKEND = targetUrl;
	process.env.EXPECTED_TARGET_TOKEN = targetToken;

	let targetState: UntypedDeployment | undefined;
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
			exportState: async () => {
				targetState = JSON.parse(await readFile(targetStateFile, "utf8"));
				return targetState as UntypedDeployment;
			},
		};
		const options: RunOptions = {
			sourceUrl: "https://source.example.test",
			sourceToken: randomUUID(),
			targetUrl,
			targetToken,
			filter: "*",
			exclude: "",
			dryRun: false,
			concurrency: 1,
			continueOnError: false,
			keepExports: false,
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
		expect(targetState?.deployment.secrets_providers).toEqual({
			type: "service",
			state: {
				url: targetUrl,
				owner: "target-org",
				project: "api",
				stack: "prod",
			},
		});
		const serializedTarget = JSON.stringify(targetState);
		expect(serializedTarget).not.toContain('"plaintext"');
		for (const secretValue of secretValues) {
			expect(serializedTarget).not.toContain(secretValue);
		}
		expect(serializedTarget.match(/"ciphertext"/g)).toHaveLength(secretValues.length);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousTargetStateFile === undefined) delete process.env.TARGET_STATE_FILE;
		else process.env.TARGET_STATE_FILE = previousTargetStateFile;
		if (previousExpectedBackend === undefined) delete process.env.EXPECTED_TARGET_BACKEND;
		else process.env.EXPECTED_TARGET_BACKEND = previousExpectedBackend;
		if (previousExpectedToken === undefined) delete process.env.EXPECTED_TARGET_TOKEN;
		else process.env.EXPECTED_TARGET_TOKEN = previousExpectedToken;
		await rm(tempDir, { recursive: true, force: true });
	}
});
