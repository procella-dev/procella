import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_SIGNATURE, SECRET_SIGNATURE_KEY } from "./compare.js";
import { type MigrationOperations, migrateOne } from "./migrate.js";
import type { DiscoveredStack, RunOptions, UntypedDeployment } from "./types.js";

// Regression tests for M2b: migrateOne's post-import verification used to compare resource
// *counts* only, so a same-count/same-URN target with corrupted ids, outputs, dependencies,
// pending operations, or secret values was silently certified as a successful migration.
// These tests pin the fix — the canonical `compareDeploymentState` comparator now runs as
// part of `migrateOne`'s own verification phase.

const stack: DiscoveredStack = {
	fqn: "target-org/api/prod",
	ref: { org: "target-org", project: "api", stack: "prod" },
	resourceCount: 1,
	lastUpdate: null,
};

function baseOptions(outputDir: string): RunOptions {
	return {
		sourceUrl: "https://source.example.test",
		sourceToken: randomUUID(),
		targetUrl: "https://target.example.test",
		targetToken: randomUUID(),
		filter: "*",
		exclude: "",
		dryRun: false,
		concurrency: 1,
		continueOnError: false,
		keepExports: false,
		outputDir,
	};
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "procella-migrate-verify-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function deployment(overrides?: Partial<UntypedDeployment["deployment"]>): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: {},
					outputs: { endpoint: "https://api.example.test" },
					dependencies: [],
				},
			],
			pending_operations: [],
			...overrides,
		},
	};
}

test("migrateOne fails when target output is corrupted despite matching resource count", async () => {
	await withTempDir(async (outputDir) => {
		const source = deployment();
		const target = deployment({
			resources: [
				{
					...(source.deployment.resources ?? [])[0],
					outputs: { endpoint: "https://corrupted.example.test" },
				},
			],
		});

		const operations: MigrationOperations = {
			exportStack: async (_fqn, filePath) => {
				await writeFile(filePath, JSON.stringify(source));
			},
			createStack: async () => ({ created: true }),
			importStack: async () => {},
			exportState: async () => target,
			batchDecrypt: async () => new Map(),
			getCallerOrg: async () => "target-org",
		};

		const result = await migrateOne(stack, 1, 1, baseOptions(outputDir), operations);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("api-prod");
		expect(result.error).toContain("outputs.endpoint");
	});
});

test("migrateOne fails when a source pending operation is silently discarded", async () => {
	await withTempDir(async (outputDir) => {
		// Mirrors real `pulumi stack import` behavior (SaveSnapshot unconditionally clears
		// PendingOperations before uploading) — the target state genuinely ends up empty.
		// A source stack with an unresolved pending operation must now fail verification
		// instead of silently completing, since that operation's data is lost on migration.
		const source = deployment({
			pending_operations: [
				{ resource: { urn: "urn:pulumi:prod::api::pkg:type::stuck" }, type: "creating" },
			],
		});
		const target = deployment({ pending_operations: [] });

		const operations: MigrationOperations = {
			exportStack: async (_fqn, filePath) => {
				await writeFile(filePath, JSON.stringify(source));
			},
			createStack: async () => ({ created: true }),
			importStack: async () => {},
			exportState: async () => target,
			batchDecrypt: async () => new Map(),
			getCallerOrg: async () => "target-org",
		};

		const result = await migrateOne(stack, 1, 1, baseOptions(outputDir), operations);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("pending_operations");
	});
});

test("migrateOne fails when the decrypted secret value diverges from source", async () => {
	await withTempDir(async (outputDir) => {
		const canary = `canary-${randomUUID()}`;
		const source = deployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: {
						password: {
							[SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE,
							plaintext: JSON.stringify(canary),
						},
					},
				},
			],
		});
		const ciphertext = Buffer.from("opaque-target-ciphertext").toString("base64");
		const target = deployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: { password: { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext } },
				},
			],
		});

		const operations: MigrationOperations = {
			exportStack: async (_fqn, filePath) => {
				await writeFile(filePath, JSON.stringify(source));
			},
			createStack: async () => ({ created: true }),
			importStack: async () => {},
			exportState: async () => target,
			batchDecrypt: async (_options, _org, _project, _stack, ciphertexts) => {
				const map = new Map<string, string>();
				for (const ct of ciphertexts) map.set(ct, JSON.stringify("a-completely-different-value"));
				return map;
			},
			getCallerOrg: async () => "target-org",
		};
		const result = await migrateOne(stack, 1, 1, baseOptions(outputDir), operations);

		expect(result.status).toBe("failed");
		expect(result.error).not.toContain(canary);
		expect(result.error).not.toContain("a-completely-different-value");
		expect(result.error).not.toContain(ciphertext);
		expect(result.error).toContain("redacted");
	});
});

test("migrateOne succeeds when the full logical state matches (no secrets involved)", async () => {
	await withTempDir(async (outputDir) => {
		const source = deployment();
		const target = deployment();

		const operations: MigrationOperations = {
			exportStack: async (_fqn, filePath) => {
				await writeFile(filePath, JSON.stringify(source));
			},
			createStack: async () => ({ created: true }),
			importStack: async () => {},
			exportState: async () => target,
			batchDecrypt: async () => new Map(),
			getCallerOrg: async () => "target-org",
		};

		const result = await migrateOne(stack, 1, 1, baseOptions(outputDir), operations);

		expect(result.status).toBe("succeeded");
		expect(result.targetResourceCount).toBe(1);
	});
});
