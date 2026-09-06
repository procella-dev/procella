import { expect, test } from "bun:test";
import { SECRET_SIGNATURE, SECRET_SIGNATURE_KEY } from "./compare.js";
import type { DiscoveredStack, UntypedDeployment, ValidateOptions } from "./types.js";
import { validate } from "./validate.js";

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
