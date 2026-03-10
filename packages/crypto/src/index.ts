// @procella/crypto — AES-256-GCM encryption with HKDF per-stack key derivation

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

// ============================================================================
// CryptoService interface
// ============================================================================

export interface CryptoService {
	encrypt(plaintext: Uint8Array, stackFQN: string): Promise<Uint8Array>;
	decrypt(ciphertext: Uint8Array, stackFQN: string): Promise<Uint8Array>;
}

// ============================================================================
// Constants
// ============================================================================

const ALGORITHM = "aes-256-gcm" as const;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = "procella-encrypt";

// ============================================================================
// AesCryptoService — production implementation
// ============================================================================

export class AesCryptoService implements CryptoService {
	private readonly masterKey: Buffer;

	constructor(masterKeyHex: string) {
		const keyBytes = Buffer.from(masterKeyHex, "hex");
		if (keyBytes.length !== KEY_LENGTH) {
			throw new Error(
				`Invalid master key length: expected ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars), got ${keyBytes.length} bytes`,
			);
		}
		this.masterKey = keyBytes;
	}

	async encrypt(plaintext: Uint8Array, stackFQN: string): Promise<Uint8Array> {
		const key = this.deriveKey(stackFQN);
		const nonce = randomBytes(NONCE_LENGTH);

		const cipher = createCipheriv(ALGORITHM, key, nonce);
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();

		// Wire format: nonce(12) || ciphertext || tag(16)
		const result = new Uint8Array(NONCE_LENGTH + encrypted.length + TAG_LENGTH);
		result.set(nonce, 0);
		result.set(encrypted, NONCE_LENGTH);
		result.set(tag, NONCE_LENGTH + encrypted.length);
		return result;
	}

	async decrypt(ciphertext: Uint8Array, stackFQN: string): Promise<Uint8Array> {
		if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
			throw new Error(
				`Ciphertext too short: expected at least ${NONCE_LENGTH + TAG_LENGTH} bytes, got ${ciphertext.length}`,
			);
		}

		const key = this.deriveKey(stackFQN);
		const nonce = ciphertext.slice(0, NONCE_LENGTH);
		const encrypted = ciphertext.slice(NONCE_LENGTH, ciphertext.length - TAG_LENGTH);
		const tag = ciphertext.slice(ciphertext.length - TAG_LENGTH);

		const decipher = createDecipheriv(ALGORITHM, key, nonce);
		decipher.setAuthTag(tag);

		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		return new Uint8Array(decrypted);
	}

	private deriveKey(stackFQN: string): Buffer {
		const derived = hkdfSync("sha256", this.masterKey, stackFQN, HKDF_INFO, KEY_LENGTH);
		return Buffer.from(derived);
	}
}

// ============================================================================
// NopCryptoService — passthrough (dev/testing without encryption)
// ============================================================================

export class NopCryptoService implements CryptoService {
	async encrypt(plaintext: Uint8Array, _stackFQN: string): Promise<Uint8Array> {
		return plaintext;
	}

	async decrypt(ciphertext: Uint8Array, _stackFQN: string): Promise<Uint8Array> {
		return ciphertext;
	}
}

// ============================================================================
// Dev helper — deterministic master key for development
// ============================================================================

/** Generate a deterministic master key from sha256("procella-dev-encryption-key"). */
export function devMasterKey(): string {
	return createHash("sha256").update("procella-dev-encryption-key").digest("hex");
}
