import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import {
	AesCryptoService,
	devMasterKey,
	NopCryptoService,
	type StackCryptoInput,
} from "./index.js";

const VERSION_V2 = 0x02;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const V1_OVERHEAD = NONCE_LENGTH + TAG_LENGTH;
const V2_OVERHEAD = 1 + NONCE_LENGTH + TAG_LENGTH;
const HKDF_INFO = "procella-encrypt";

function devService(): AesCryptoService {
	return new AesCryptoService(devMasterKey());
}

function stackInput(overrides?: Partial<StackCryptoInput>): StackCryptoInput {
	return {
		stackId: "11111111-1111-1111-1111-111111111111",
		stackFQN: "acme/my-project/production",
		...overrides,
	};
}

function legacyEncrypt(
	masterKeyHex: string,
	input: StackCryptoInput,
	plaintext: Uint8Array,
	nonce = Buffer.alloc(NONCE_LENGTH, 7),
): Uint8Array {
	const key = Buffer.from(
		hkdfSync("sha256", Buffer.from(masterKeyHex, "hex"), input.stackFQN, HKDF_INFO, 32),
	);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return new Uint8Array(Buffer.concat([nonce, encrypted, tag]));
}

describe("@procella/crypto", () => {
	describe("AesCryptoService", () => {
		test("encrypt always writes v2 ciphertexts with version prefix", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("hello world");

			const encrypted = await svc.encrypt(stackInput(), plaintext);

			expect(encrypted[0]).toBe(VERSION_V2);
			expect(encrypted.length).toBe(plaintext.length + V2_OVERHEAD);
		});

		test("decrypt reads v2 ciphertext", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("hello world");
			const input = stackInput();

			const encrypted = await svc.encrypt(input, plaintext);
			const decrypted = await svc.decrypt(input, encrypted);

			expect(decrypted).toEqual(plaintext);
		});

		test("decrypt falls back to v1 for legacy ciphertext", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("legacy secret");
			const input = stackInput();

			const encrypted = legacyEncrypt(devMasterKey(), input, plaintext);
			const decrypted = await svc.decrypt(input, encrypted);

			expect(decrypted).toEqual(plaintext);
		});

		test("decrypt with v1 fallback uses stackFQN", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("legacy secret");
			const input = stackInput();
			const encrypted = legacyEncrypt(devMasterKey(), input, plaintext);

			await expect(
				svc.decrypt(stackInput({ stackId: "22222222-2222-2222-2222-222222222222" }), encrypted),
			).resolves.toEqual(plaintext);
			await expect(
				svc.decrypt(stackInput({ stackFQN: "acme/my-project/renamed" }), encrypted),
			).rejects.toThrow();
		});

		test("decrypt with v2 uses stackId not stackFQN", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("current secret");
			const input = stackInput();
			const encrypted = await svc.encrypt(input, plaintext);

			await expect(
				svc.decrypt(stackInput({ stackFQN: "acme/my-project/renamed" }), encrypted),
			).resolves.toEqual(plaintext);
			await expect(
				svc.decrypt(stackInput({ stackId: "22222222-2222-2222-2222-222222222222" }), encrypted),
			).rejects.toThrow();
		});

		test("rename simulation: v2 ciphertext still decrypts after FQN change", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("rename-safe secret");
			const beforeRename = stackInput();
			const afterRename = stackInput({ stackFQN: "acme/my-project/prod-renamed" });

			const encrypted = await svc.encrypt(beforeRename, plaintext);
			const decrypted = await svc.decrypt(afterRename, encrypted);

			expect(decrypted).toEqual(plaintext);
		});

		test("delete and recreate simulation: new v2 ciphertext does not decrypt with old stackId", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("recreated stack secret");
			const oldStack = stackInput({ stackId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
			const recreatedStack = stackInput({ stackId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });

			const encrypted = await svc.encrypt(recreatedStack, plaintext);

			await expect(svc.decrypt(oldStack, encrypted)).rejects.toThrow();
			await expect(svc.decrypt(recreatedStack, encrypted)).resolves.toEqual(plaintext);
		});

		test("different stack identities produce different ciphertext payloads", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("same data");

			const enc1 = await svc.encrypt(stackInput(), plaintext);
			const enc2 = await svc.encrypt(
				stackInput({ stackId: "22222222-2222-2222-2222-222222222222" }),
				plaintext,
			);

			const data1 = enc1.slice(1 + NONCE_LENGTH, enc1.length - TAG_LENGTH);
			const data2 = enc2.slice(1 + NONCE_LENGTH, enc2.length - TAG_LENGTH);
			expect(Buffer.from(data1).equals(Buffer.from(data2))).toBe(false);
		});

		test("decryption with tampered ciphertext fails", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("important data");
			const encrypted = await svc.encrypt(stackInput(), plaintext);

			const tampered = new Uint8Array(encrypted);
			tampered[1 + NONCE_LENGTH + 1] ^= 0xff;

			await expect(svc.decrypt(stackInput(), tampered)).rejects.toThrow();
		});

		test("constructor rejects invalid key lengths", () => {
			expect(() => new AesCryptoService("abcd")).toThrow("Invalid master key length");
			expect(() => new AesCryptoService("a".repeat(66))).toThrow("Invalid master key length");
			expect(() => new AesCryptoService("")).toThrow("Invalid master key length");
		});

		test("decrypt rejects ciphertext shorter than minimum v1 overhead", async () => {
			const svc = devService();
			const tooShort = new Uint8Array(V1_OVERHEAD - 1);
			await expect(svc.decrypt(stackInput(), tooShort)).rejects.toThrow("Ciphertext too short");
		});

		test("encrypt and decrypt work with empty plaintext", async () => {
			const svc = devService();
			const empty = new Uint8Array(0);

			const encrypted = await svc.encrypt(stackInput(), empty);
			expect(encrypted.length).toBe(V2_OVERHEAD);

			const decrypted = await svc.decrypt(stackInput(), encrypted);
			expect(decrypted.length).toBe(0);
		});

		test("each encryption produces a unique nonce", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("test");

			const enc1 = await svc.encrypt(stackInput(), plaintext);
			const enc2 = await svc.encrypt(stackInput(), plaintext);

			const nonce1 = enc1.slice(1, 1 + NONCE_LENGTH);
			const nonce2 = enc2.slice(1, 1 + NONCE_LENGTH);
			expect(Buffer.from(nonce1).equals(Buffer.from(nonce2))).toBe(false);
		});
	});

	describe("NopCryptoService", () => {
		test("returns input unchanged for encrypt and decrypt", async () => {
			const svc = new NopCryptoService();
			const data = new TextEncoder().encode("passthrough data");
			const input = stackInput();

			const encrypted = await svc.encrypt(input, data);
			expect(encrypted).toEqual(data);

			const decrypted = await svc.decrypt(input, data);
			expect(decrypted).toEqual(data);
		});
	});

	describe("devMasterKey", () => {
		test("returns consistent 32-byte key as 64 hex chars", () => {
			const key1 = devMasterKey();
			const key2 = devMasterKey();

			expect(key1).toBe(key2);
			expect(key1.length).toBe(64);
			expect(/^[0-9a-f]{64}$/.test(key1)).toBe(true);
			expect(Buffer.from(key1, "hex")).toHaveLength(32);
		});

		test("matches the documented sha256 seed", () => {
			const expected = createHash("sha256").update("procella-dev-encryption-key").digest("hex");
			expect(devMasterKey()).toBe(expected);
		});
	});
});
