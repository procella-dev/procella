// E2E — Encrypt/decrypt: CLI config secrets, HTTP API single + batch roundtrips.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	pulumi,
	truncateTables,
} from "./helpers.js";

describe("encrypt and decrypt", () => {
	let pulumiHome: string;
	let projectDir: string;
	let ciphertextFromTest2: string;

	beforeAll(async () => {
		pulumiHome = await createPulumiHome();
		await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome });

		// Create stack for API tests
		projectDir = await newProjectDir("crypto-proj");
		const initRes = await pulumi(["stack", "init", "dev-org/crypto-proj/dev"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(initRes.exitCode).toBe(0);
	});

	afterAll(async () => {
		if (projectDir) await cleanupDir(projectDir);
		await cleanupDir(pulumiHome);
		await truncateTables();
	});

	test("pulumi config set --secret roundtrip", async () => {
		const setRes = await pulumi(["config", "set", "--secret", "myKey", "mySecretValue"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(setRes.exitCode).toBe(0);

		const getRes = await pulumi(["config", "get", "myKey"], {
			cwd: projectDir,
			pulumiHome,
		});
		expect(getRes.exitCode).toBe(0);
		expect(getRes.stdout.trim()).toBe("mySecretValue");
	});

	test("encrypt/decrypt single value via HTTP", async () => {
		const plaintext = btoa("my-secret-value");
		const encryptRes = await apiRequest("/stacks/dev-org/crypto-proj/dev/encrypt", {
			method: "POST",
			body: { plaintext },
		});
		expect(encryptRes.status).toBe(200);
		const { ciphertext } = await encryptRes.json();
		expect(ciphertext).toBeDefined();
		ciphertextFromTest2 = ciphertext;

		const decryptRes = await apiRequest("/stacks/dev-org/crypto-proj/dev/decrypt", {
			method: "POST",
			body: { ciphertext },
		});
		expect(decryptRes.status).toBe(200);
		const { plaintext: decrypted } = await decryptRes.json();
		expect(decrypted).toBe(plaintext);
	});

	test("batch encrypt/decrypt via HTTP", async () => {
		const plaintexts = [btoa("secret-1"), btoa("secret-2")];

		const encryptRes = await apiRequest("/stacks/dev-org/crypto-proj/dev/batch-encrypt", {
			method: "POST",
			body: { plaintexts },
		});
		expect(encryptRes.status).toBe(200);
		const { ciphertexts } = await encryptRes.json();
		expect(ciphertexts).toBeArray();
		expect(ciphertexts).toHaveLength(2);

		const decryptRes = await apiRequest("/stacks/dev-org/crypto-proj/dev/batch-decrypt", {
			method: "POST",
			body: { ciphertexts },
		});
		expect(decryptRes.status).toBe(200);
		const { plaintexts: decrypted } = await decryptRes.json();
		// Response is a map: ciphertext → plaintext
		expect(typeof decrypted).toBe("object");
		expect(Object.keys(decrypted)).toHaveLength(2);
		// Verify each ciphertext maps back to its original plaintext
		for (let i = 0; i < ciphertexts.length; i++) {
			expect(decrypted[ciphertexts[i]]).toBe(plaintexts[i]);
		}
	});

	test("encrypted value differs from plaintext", async () => {
		const plaintext = btoa("my-secret-value");
		expect(ciphertextFromTest2).toBeDefined();
		expect(ciphertextFromTest2).not.toBe(plaintext);
	});
});
