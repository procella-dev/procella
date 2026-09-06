import { describe, expect, test } from "bun:test";
import {
	type BatchSecretDecrypter,
	compareDeploymentState,
	describeFirstMismatch,
	SECRET_SIGNATURE,
	SECRET_SIGNATURE_KEY,
} from "./compare.js";
import type { UntypedDeployment } from "./types.js";

type ResourceFixture = NonNullable<UntypedDeployment["deployment"]["resources"]>[number];

function plaintextSecret(value: string): Record<string, unknown> {
	return { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, plaintext: JSON.stringify(value) };
}

function ciphertextSecret(ciphertext: string): Record<string, unknown> {
	return { [SECRET_SIGNATURE_KEY]: SECRET_SIGNATURE, ciphertext };
}

/** A decrypter matching real Pulumi service-provider re-encryption of the same logical value. */
function decrypterFor(map: Record<string, string>): BatchSecretDecrypter {
	return async (ciphertexts) => {
		const result = new Map<string, string>();
		for (const ct of ciphertexts) {
			if (ct in map) result.set(ct, JSON.stringify(map[ct]));
		}
		return result;
	};
}

function baseDeployment(overrides?: Partial<UntypedDeployment["deployment"]>): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			manifest: { time: "2026-01-01T00:00:00Z", magic: "abc", version: "3.100.0" },
			secrets_providers: { type: "passphrase", state: { salt: "source-salt" } },
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: { size: "small" },
					outputs: { endpoint: "https://api.example.test" },
					dependencies: [],
				},
			],
			pending_operations: [],
			...overrides,
		},
	};
}

function cloneDeployment(source: UntypedDeployment): UntypedDeployment {
	return JSON.parse(JSON.stringify(source));
}

function firstResource(deployment: UntypedDeployment): ResourceFixture {
	const resource = deployment.deployment.resources?.[0];
	if (!resource) throw new Error("test fixture is missing deployment.resources[0]");
	return resource;
}

function manifestOf(deployment: UntypedDeployment): {
	time: string;
	magic: string;
	version: string;
} {
	const manifest = deployment.deployment.manifest;
	if (!manifest) throw new Error("test fixture is missing deployment.manifest");
	return manifest;
}

describe("compareDeploymentState — baseline", () => {
	test("identical deployments match", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
		expect(result.unverifiable).toBe(false);
		expect(result.mismatches).toEqual([]);
	});
});

describe("compareDeploymentState — material corruption with unchanged count/URN", () => {
	test("altered resource id is rejected", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).id = "res-corrupted";

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(false);
		expect(result.sourceResourceCount).toBe(result.targetResourceCount);
		expect(result.mismatches.some((m) => m.kind === "field-mismatch" && m.path === "id")).toBe(
			true,
		);
	});

	test("altered output value is rejected", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).outputs = { endpoint: "https://attacker.example.test" };

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(
			result.mismatches.some((m) => m.kind === "field-mismatch" && m.path === "outputs.endpoint"),
		).toBe(true);
	});

	test("altered dependency edge is rejected", async () => {
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: {},
					outputs: {},
					dependencies: ["urn:pulumi:prod::api::pkg:type::dep-a"],
				},
			],
		});
		const target = cloneDeployment(source);
		firstResource(target).dependencies = ["urn:pulumi:prod::api::pkg:type::dep-b"];

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(
			result.mismatches.some((m) => m.kind === "field-mismatch" && m.path === "dependencies[0]"),
		).toBe(true);
	});

	test("altered pending operation is rejected", async () => {
		const source = baseDeployment({
			pending_operations: [
				{ resource: { urn: "urn:pulumi:prod::api::pkg:type::res" }, type: "creating" },
			],
		});
		const target = cloneDeployment(source);
		// Simulates the real `pulumi stack import` behavior of discarding pending operations
		// (pkg/cmd/pulumi/stack/io.go SaveSnapshot) — silently losing this is exactly the bug
		// count-only verification used to hide.
		target.deployment.pending_operations = [];

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "pending_operations")).toBe(true);
	});

	test("altered secret logical value is rejected", async () => {
		const canary = `canary-${crypto.randomUUID()}`;
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: {},
					outputs: { password: plaintextSecret(canary) },
					dependencies: [],
				},
			],
		});
		const target = cloneDeployment(source);
		const tamperedCiphertext = Buffer.from(JSON.stringify("tampered-value")).toString("base64");
		firstResource(target).outputs = { password: ciphertextSecret(tamperedCiphertext) };

		const result = await compareDeploymentState(source, target, {
			decryptTarget: decrypterFor({ [tamperedCiphertext]: "tampered-value" }),
		});

		expect(result.match).toBe(false);
		const detail = JSON.stringify(result.mismatches);
		expect(detail).not.toContain(canary);
		expect(detail).not.toContain("tampered-value");
		expect(detail).not.toContain(tamperedCiphertext);
	});

	test("resource present only on source is rejected", async () => {
		const base = baseDeployment();
		const source = baseDeployment({
			resources: [
				...(base.deployment.resources ?? []),
				{ urn: "urn:pulumi:prod::api::pkg:type::extra", type: "pkg:type" },
			],
		});
		const target = baseDeployment();

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(
			result.mismatches.some(
				(m) => m.kind === "missing-on-target" && m.urn === "urn:pulumi:prod::api::pkg:type::extra",
			),
		).toBe(true);
	});

	test("duplicate URN group of differing size is rejected", async () => {
		const base = baseDeployment();
		const dup = {
			urn: "urn:pulumi:prod::api::pkg:type::replaced",
			type: "pkg:type",
			delete: true,
		};
		const source = baseDeployment({
			resources: [...(base.deployment.resources ?? []), dup, { ...dup }],
		});
		const target = baseDeployment({
			resources: [...(base.deployment.resources ?? []), dup],
		});

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.kind === "duplicate-urn-count")).toBe(true);
	});

	test("unrecognised deployment-level field is preserved and compared", async () => {
		const source = baseDeployment({ future_field: { flavor: "blue" } });
		const target = baseDeployment({ future_field: { flavor: "green" } });

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path.startsWith("future_field"))).toBe(true);
	});
});

describe("compareDeploymentState — legitimate target-provider rebinding", () => {
	test("equivalent state after correct target re-encryption succeeds", async () => {
		const canary = `canary-${crypto.randomUUID()}`;
		const source = baseDeployment({
			secrets_providers: { type: "passphrase", state: { salt: "source-salt" } },
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					id: "res-1",
					inputs: { database: plaintextSecret(canary) },
					outputs: {},
					dependencies: [],
				},
			],
		});
		const target = cloneDeployment(source);
		target.deployment.secrets_providers = {
			type: "service",
			state: {
				url: "https://target.example.test",
				owner: "target-org",
				project: "api",
				stack: "prod",
			},
		};
		// Same logical value, genuinely different (target-encrypted) ciphertext bytes.
		const realCiphertext = Buffer.from(`${Math.random()}:${canary}`).toString("base64");
		firstResource(target).inputs = { database: ciphertextSecret(realCiphertext) };

		const result = await compareDeploymentState(source, target, {
			decryptTarget: decrypterFor({ [realCiphertext]: canary }),
		});

		expect(result.match).toBe(true);
		expect(result.unverifiable).toBe(false);
	});

	test("manifest.time difference alone is normalized away", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		manifestOf(target).time = "2099-12-31T23:59:59Z";

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(true);
	});

	test("manifest.version difference is still caught", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		manifestOf(target).version = "3.0.0-corrupted";

		const result = await compareDeploymentState(source, target);
		expect(result.match).toBe(false);
		expect(result.mismatches.some((m) => m.path === "manifest.version")).toBe(true);
	});
});

describe("compareDeploymentState — unverifiable states never certify a match", () => {
	test("ciphertext secret with no decrypter fails clearly, not silently", async () => {
		const canary = `canary-${crypto.randomUUID()}`;
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: { password: plaintextSecret(canary) },
				},
			],
		});
		const ciphertext = Buffer.from(JSON.stringify(canary)).toString("base64");
		const target = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod",
					type: "pulumi:pulumi:Stack",
					outputs: { password: ciphertextSecret(ciphertext) },
				},
			],
		});

		const result = await compareDeploymentState(source, target);

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
		expect(result.mismatches.some((m) => m.kind === "unverifiable-secret")).toBe(true);
		const detail = JSON.stringify(result.mismatches);
		expect(detail).not.toContain(canary);
		expect(detail).not.toContain(ciphertext);
	});

	test("decrypter that cannot resolve the ciphertext fails clearly", async () => {
		const ciphertext = Buffer.from(JSON.stringify("value")).toString("base64");
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pkg:type::a",
					type: "pkg:type",
					outputs: { secret: ciphertextSecret(ciphertext) },
				},
			],
		});
		const target = cloneDeployment(source);

		const result = await compareDeploymentState(source, target, {
			decryptSource: async () => new Map(),
			decryptTarget: async () => new Map(),
		});

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
	});

	test("decrypter throwing is treated as unverifiable, not a crash", async () => {
		const ciphertext = Buffer.from(JSON.stringify("value")).toString("base64");
		const source = baseDeployment({
			resources: [
				{
					urn: "urn:pulumi:prod::api::pkg:type::a",
					type: "pkg:type",
					outputs: { secret: ciphertextSecret(ciphertext) },
				},
			],
		});
		const target = cloneDeployment(source);

		const result = await compareDeploymentState(source, target, {
			decryptTarget: async () => {
				throw new Error("network error");
			},
		});

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
	});

	test("unsupported deployment schema version fails clearly", async () => {
		const source = baseDeployment();
		const target = { ...cloneDeployment(source), version: 99 };

		const result = await compareDeploymentState(source, target);

		expect(result.match).toBe(false);
		expect(result.unverifiable).toBe(true);
		expect(result.mismatches.some((m) => m.kind === "unsupported-schema")).toBe(true);
	});
});

describe("describeFirstMismatch", () => {
	test("reports the first mismatch and a count of the rest", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		firstResource(target).id = "corrupted";
		firstResource(target).outputs = { endpoint: "corrupted" };

		const result = await compareDeploymentState(source, target);
		const description = describeFirstMismatch(result);
		expect(description).toContain("urn:pulumi:prod::api::pulumi:pulumi:Stack::api-prod");
		expect(description).toMatch(/and \d+ more mismatch/);
	});

	test("reports 'deployments match' when there are no mismatches", async () => {
		const source = baseDeployment();
		const target = cloneDeployment(source);
		const result = await compareDeploymentState(source, target);
		expect(describeFirstMismatch(result)).toBe("deployments match");
	});
});
