import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_SIGNATURE, SECRET_SIGNATURE_KEY } from "./compare.js";
import type { DiscoveredStack, UntypedDeployment, ValidateOptions } from "./types.js";
import { exportFromBackend, validate } from "./validate.js";

// Regression tests for M2b: standalone `validate()` used to compare resource *URN sets*
// only, so same-count/same-URN states with corrupted ids/outputs/dependencies/secrets were
// certified as "match". These tests pin the fix — `validate()` now runs the same canonical
// `compareDeploymentState` comparator migrateOne uses.

function makeStack(fqn: string): DiscoveredStack {
	const [org = "", project = "", stack = ""] = fqn.split("/");
	return { fqn, ref: { org, project, stack }, resourceCount: 1, lastUpdate: null };
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

function baseOpts(): ValidateOptions {
	return {
		sourceUrl: "https://source.example.test",
		sourceToken: "source-token",
		targetUrl: "https://target.example.test",
		targetToken: "target-token",
		filter: "*",
		exclude: "",
	};
}

test("validate reports match for identical logical state", async () => {
	const source = makeStack("org-a/api/prod");
	const target = makeStack("target-org/api/prod");
	const state = deployment();

	const [result] = await validate(baseOpts(), {
		discoverStacks: async (url) => (url.includes("source") ? [source] : [target]),
		exportFromBackend: async () => state,
		exportState: async () => state,
		batchDecrypt: async () => new Map(),
	});

	expect(result.status).toBe("match");
	expect(result.mismatches).toEqual([]);
});

test("validate reports mismatch for corrupted output despite matching resource count", async () => {
	const source = makeStack("org-a/api/prod");
	const target = makeStack("target-org/api/prod");
	const sourceState = deployment();
	const targetState = deployment({
		resources: [
			{
				...(sourceState.deployment.resources ?? [])[0],
				outputs: { endpoint: "https://corrupted.example.test" },
			},
		],
	});

	const [result] = await validate(baseOpts(), {
		discoverStacks: async (url) => (url.includes("source") ? [source] : [target]),
		exportFromBackend: async () => sourceState,
		exportState: async () => targetState,
		batchDecrypt: async () => new Map(),
	});

	expect(result.status).toBe("mismatch");
	expect(result.unverifiable).toBeFalsy();
	expect(result.error).toContain("outputs.endpoint");
	expect(result.mismatches?.some((m) => m.kind === "field-mismatch")).toBe(true);
});

test("validate reports error for an undecryptable secret and never labels it a match", async () => {
	const source = makeStack("org-a/api/prod");
	const target = makeStack("target-org/api/prod");
	const canary = "canary-secret-value";
	const sourceState = deployment({
		resources: [
			{
				urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
				type: "pulumi:pulumi:Stack",
				outputs: {
					password: { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, plaintext: JSON.stringify(canary) },
				},
			},
		],
	});
	const ciphertext = Buffer.from("opaque").toString("base64");
	const targetState = deployment({
		resources: [
			{
				urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
				type: "pulumi:pulumi:Stack",
				outputs: { password: { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext } },
			},
		],
	});

	const [result] = await validate(baseOpts(), {
		discoverStacks: async (url) => (url.includes("source") ? [source] : [target]),
		exportFromBackend: async () => sourceState,
		exportState: async () => targetState,
		// Target backend cannot decrypt this ciphertext (e.g. wrong provider) — returns nothing.
		batchDecrypt: async () => new Map(),
	});

	expect(result.status).toBe("error");
	expect(result.unverifiable).toBe(true);
	expect(result.error).not.toContain(canary);
	expect(JSON.stringify(result.mismatches)).not.toContain(canary);
});

test("validate succeeds across legitimate secret re-encryption via each backend's own decrypt", async () => {
	const source = makeStack("org-a/api/prod");
	const target = makeStack("target-org/api/prod");
	const canary = "canary-secret-value";
	const sourceCiphertext = Buffer.from("source-ciphertext").toString("base64");
	const targetCiphertext = Buffer.from("target-ciphertext").toString("base64");
	const sourceState = deployment({
		secrets_providers: {
			type: "service",
			state: { owner: "org-a", project: "api", stack: "prod" },
		},
		resources: [
			{
				urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
				type: "pulumi:pulumi:Stack",
				outputs: {
					password: { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext: sourceCiphertext },
				},
			},
		],
	});
	const targetState = deployment({
		secrets_providers: {
			type: "service",
			state: { owner: "target-org", project: "api", stack: "prod" },
		},
		resources: [
			{
				urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
				type: "pulumi:pulumi:Stack",
				outputs: {
					password: { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext: targetCiphertext },
				},
			},
		],
	});

	const [result] = await validate(baseOpts(), {
		discoverStacks: async (url) => (url.includes("source") ? [source] : [target]),
		exportFromBackend: async () => sourceState,
		exportState: async () => targetState,
		batchDecrypt: async (_opts, org, _project, _stack, ciphertexts) => {
			const map = new Map<string, string>();
			for (const ct of ciphertexts) {
				if (org === "org-a" && ct === sourceCiphertext) map.set(ct, JSON.stringify(canary));
				if (org === "target-org" && ct === targetCiphertext) map.set(ct, JSON.stringify(canary));
			}
			return map;
		},
	});

	expect(result.status).toBe("match");
});

test("exportFromBackend falls back to the CLI for a non-service secrets provider", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "procella-validate-export-fallback-"));
	const binDir = join(tempDir, "bin");
	const url = "https://source.example.test";
	const token = "source-token";
	const ref = { org: "org-a", project: "api", stack: "prod" };

	// The raw HTTP export reports a passphrase-encrypted stack — its ciphertext cannot be
	// decrypted through this backend's own /batch-decrypt (passphrase keys are client-side
	// only), so exportFromBackend must fall through to the CLI rather than trust it.
	const httpDeployment: UntypedDeployment = {
		version: 3,
		deployment: {
			secrets_providers: { type: "passphrase", state: { salt: "s" } },
			resources: [{ urn: "urn:pulumi:prod::api::pkg:type::http", type: "pkg:type" }],
		},
	};
	const cliDeployment: UntypedDeployment = {
		version: 3,
		deployment: {
			secrets_providers: { type: "passphrase", state: { salt: "s" } },
			resources: [{ urn: "urn:pulumi:prod::api::pkg:type::cli", type: "pkg:type" }],
		},
	};

	const fakePulumi = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
if (args[1] === "stack" && args[2] === "export" && args.includes("--show-secrets")) {
	fs.writeFileSync(args[fileIndex + 1], ${JSON.stringify(JSON.stringify(cliDeployment))});
	process.exit(0);
}
process.exit(11);
`;
	await mkdir(binDir);
	const pulumiPath = join(binDir, "pulumi");
	await writeFile(pulumiPath, fakePulumi);
	await chmod(pulumiPath, 0o755);

	const previousPath = process.env.PATH;
	const previousFetch = globalThis.fetch;
	process.env.PATH = `${binDir}:${previousPath ?? ""}`;
	const fakeFetch = async () => new Response(JSON.stringify(httpDeployment), { status: 200 });
	// Bun's `fetch` type also declares `preconnect`, which a plain async function lacks;
	// this stub is never called through that member.
	globalThis.fetch = fakeFetch as unknown as typeof fetch;

	try {
		const result = await exportFromBackend(url, token, ref);
		expect(result).toEqual(cliDeployment);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		globalThis.fetch = previousFetch;
		await rm(tempDir, { recursive: true, force: true });
	}
});
