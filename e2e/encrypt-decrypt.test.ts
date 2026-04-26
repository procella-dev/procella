// E2E — Encrypt/decrypt: CLI config secrets, HTTP API single + batch roundtrips.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	apiRequest,
	BACKEND_URL,
	cleanupDir,
	createPulumiHome,
	newProjectDir,
	pulumi,
	TEST_TOKEN_USER_B,
	truncateTables,
} from "./helpers.js";

describe("encrypt and decrypt", () => {
	let pulumiHomeA: string;
	let projectDirA: string;
	let ciphertextFromTest2: string;
	const stackAPath = "dev-org/crypto-proj-a/dev";
	const stackBPath = "org-b/crypto-proj-b/dev";

	beforeAll(async () => {
		pulumiHomeA = await createPulumiHome();
		await pulumi(["login", "--cloud-url", BACKEND_URL], { pulumiHome: pulumiHomeA });

		projectDirA = await newProjectDir("crypto-proj-a");
		const initA = await pulumi(["stack", "init", stackAPath], {
			cwd: projectDirA,
			pulumiHome: pulumiHomeA,
		});
		expect(initA.exitCode).toBe(0);

		const createStackB = await apiRequest(`/stacks/${stackBPath}`, {
			method: "POST",
			token: TEST_TOKEN_USER_B,
			body: {},
		});
		expect(createStackB.status).toBe(200);
	});

	afterAll(async () => {
		if (projectDirA) await cleanupDir(projectDirA);
		if (pulumiHomeA) await cleanupDir(pulumiHomeA);
		await truncateTables();
	});

	test("pulumi config set --secret roundtrip", async () => {
		const setRes = await pulumi(["config", "set", "--secret", "myKey", "mySecretValue"], {
			cwd: projectDirA,
			pulumiHome: pulumiHomeA,
		});
		expect(setRes.exitCode).toBe(0);

		const getRes = await pulumi(["config", "get", "myKey"], {
			cwd: projectDirA,
			pulumiHome: pulumiHomeA,
		});
		expect(getRes.exitCode).toBe(0);
		expect(getRes.stdout.trim()).toBe("mySecretValue");
	});

	test("encrypt/decrypt single value via HTTP", async () => {
		const plaintext = btoa("my-secret-value");
		const encryptRes = await apiRequest(`/stacks/${stackAPath}/encrypt`, {
			method: "POST",
			body: { plaintext },
		});
		expect(encryptRes.status).toBe(200);
		const { ciphertext } = await encryptRes.json();
		expect(ciphertext).toBeDefined();
		ciphertextFromTest2 = ciphertext;

		const decryptRes = await apiRequest(`/stacks/${stackAPath}/decrypt`, {
			method: "POST",
			body: { ciphertext },
		});
		expect(decryptRes.status).toBe(200);
		const { plaintext: decrypted } = await decryptRes.json();
		expect(decrypted).toBe(plaintext);
	});

	test("batch encrypt/decrypt via HTTP", async () => {
		const plaintexts = [btoa("secret-1"), btoa("secret-2")];

		const encryptRes = await apiRequest(`/stacks/${stackAPath}/batch-encrypt`, {
			method: "POST",
			body: { plaintexts },
		});
		expect(encryptRes.status).toBe(200);
		const { ciphertexts } = await encryptRes.json();
		expect(ciphertexts).toBeArray();
		expect(ciphertexts).toHaveLength(2);

		const decryptRes = await apiRequest(`/stacks/${stackAPath}/batch-decrypt`, {
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

	test("cross-tenant decrypt against another tenant stack returns 404", async () => {
		const plaintext = btoa("tenant-a-secret");
		const encryptRes = await apiRequest(`/stacks/${stackAPath}/encrypt`, {
			method: "POST",
			body: { plaintext },
		});
		expect(encryptRes.status).toBe(200);
		const { ciphertext } = await encryptRes.json();

		const decryptRes = await apiRequest(`/stacks/${stackAPath}/decrypt`, {
			method: "POST",
			token: TEST_TOKEN_USER_B,
			body: { ciphertext },
		});

		expect(decryptRes.status).toBe(404);
		expect(await decryptRes.json()).toEqual({ code: "stack_not_found" });
	});
});
