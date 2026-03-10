import { describe, expect, test } from "bun:test";
import { AesCryptoService, devMasterKey, NopCryptoService } from "./index.js";

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const OVERHEAD = NONCE_LENGTH + TAG_LENGTH; // 28 bytes

/** Helper: create an AesCryptoService with the dev master key. */
function devService(): AesCryptoService {
	return new AesCryptoService(devMasterKey());
}

describe("@procella/crypto", () => {
	describe("AesCryptoService", () => {
		test("encrypt then decrypt roundtrip returns original plaintext", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("hello world");
			const stackFQN = "acme/my-project/production";

			const encrypted = await svc.encrypt(plaintext, stackFQN);
			const decrypted = await svc.decrypt(encrypted, stackFQN);

			expect(decrypted).toEqual(plaintext);
		});

		test("different stack FQNs produce different ciphertexts", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("same data");

			const enc1 = await svc.encrypt(plaintext, "org/proj/stack-a");
			const enc2 = await svc.encrypt(plaintext, "org/proj/stack-b");

			// Different keys → different ciphertext (ignoring nonce randomness)
			// Extract encrypted portion (skip nonce, remove tag)
			const data1 = enc1.slice(NONCE_LENGTH, enc1.length - TAG_LENGTH);
			const data2 = enc2.slice(NONCE_LENGTH, enc2.length - TAG_LENGTH);
			expect(Buffer.from(data1).equals(Buffer.from(data2))).toBe(false);
		});

		test("decryption with wrong stack FQN fails", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("secret");
			const encrypted = await svc.encrypt(plaintext, "org/proj/correct");

			await expect(svc.decrypt(encrypted, "org/proj/wrong")).rejects.toThrow();
		});

		test("decryption with tampered ciphertext fails (GCM auth tag)", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("important data");
			const stackFQN = "acme/proj/stack";

			const encrypted = await svc.encrypt(plaintext, stackFQN);

			// Tamper with a byte in the encrypted payload
			const tampered = new Uint8Array(encrypted);
			tampered[NONCE_LENGTH + 1] ^= 0xff;

			await expect(svc.decrypt(tampered, stackFQN)).rejects.toThrow();
		});

		test("wire format: output length is input length + 28 (nonce + tag)", async () => {
			const svc = devService();
			const stackFQN = "org/proj/stack";

			for (const size of [0, 1, 16, 100, 1024]) {
				const plaintext = new Uint8Array(size);
				const encrypted = await svc.encrypt(plaintext, stackFQN);
				expect(encrypted.length).toBe(size + OVERHEAD);
			}
		});

		test("constructor rejects invalid key lengths", () => {
			// Too short
			expect(() => new AesCryptoService("abcd")).toThrow("Invalid master key length");
			// Too long (33 bytes = 66 hex chars)
			expect(() => new AesCryptoService("a".repeat(66))).toThrow("Invalid master key length");
			// Empty
			expect(() => new AesCryptoService("")).toThrow("Invalid master key length");
		});

		test("decrypt rejects ciphertext shorter than overhead", async () => {
			const svc = devService();
			const tooShort = new Uint8Array(OVERHEAD - 1);
			await expect(svc.decrypt(tooShort, "org/proj/stack")).rejects.toThrow("Ciphertext too short");
		});

		test("encrypt/decrypt works with empty plaintext", async () => {
			const svc = devService();
			const empty = new Uint8Array(0);
			const stackFQN = "org/proj/stack";

			const encrypted = await svc.encrypt(empty, stackFQN);
			expect(encrypted.length).toBe(OVERHEAD);

			const decrypted = await svc.decrypt(encrypted, stackFQN);
			expect(decrypted.length).toBe(0);
		});

		test("each encryption produces unique nonce (non-deterministic)", async () => {
			const svc = devService();
			const plaintext = new TextEncoder().encode("test");
			const stackFQN = "org/proj/stack";

			const enc1 = await svc.encrypt(plaintext, stackFQN);
			const enc2 = await svc.encrypt(plaintext, stackFQN);

			// Nonces (first 12 bytes) should differ
			const nonce1 = enc1.slice(0, NONCE_LENGTH);
			const nonce2 = enc2.slice(0, NONCE_LENGTH);
			expect(Buffer.from(nonce1).equals(Buffer.from(nonce2))).toBe(false);
		});
	});

	describe("NopCryptoService", () => {
		test("returns input unchanged for encrypt and decrypt", async () => {
			const svc = new NopCryptoService();
			const data = new TextEncoder().encode("passthrough data");

			const encrypted = await svc.encrypt(data, "org/proj/stack");
			expect(encrypted).toEqual(data);

			const decrypted = await svc.decrypt(data, "org/proj/stack");
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

			// Verify it produces a valid 32-byte buffer
			const keyBytes = Buffer.from(key1, "hex");
			expect(keyBytes.length).toBe(32);
		});
	});
});
