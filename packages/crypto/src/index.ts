// @procella/crypto — AES-256-GCM encryption with HKDF per-stack key derivation

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { cryptoOperationCount } from "@procella/telemetry";

// ============================================================================
// CryptoService interface
// ============================================================================

export interface CryptoService {
	encrypt(input: StackCryptoInput, plaintext: Uint8Array): Promise<Uint8Array>;
	decrypt(input: StackCryptoInput, ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface StackCryptoInput {
	stackId: string;
	stackFQN: string;
}

// ============================================================================
// Constants
// ============================================================================

const ALGORITHM = "aes-256-gcm" as const;
const CIPHERTEXT_VERSION_V2 = 0x02;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = "procella-encrypt";
const STACK_ID_LENGTH = 16;

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

	async encrypt(input: StackCryptoInput, plaintext: Uint8Array): Promise<Uint8Array> {
		cryptoOperationCount().add(1, { operation: "encrypt" });
		const key = this.deriveV2Key(input.stackId);
		const nonce = randomBytes(NONCE_LENGTH);

		const cipher = createCipheriv(ALGORITHM, key, nonce);
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();

		// Wire format v2: version(1) || nonce(12) || ciphertext || tag(16)
		const result = new Uint8Array(1 + NONCE_LENGTH + encrypted.length + TAG_LENGTH);
		result[0] = CIPHERTEXT_VERSION_V2;
		result.set(nonce, 1);
		result.set(encrypted, 1 + NONCE_LENGTH);
		result.set(tag, 1 + NONCE_LENGTH + encrypted.length);
		return result;
	}

	async decrypt(input: StackCryptoInput, ciphertext: Uint8Array): Promise<Uint8Array> {
		cryptoOperationCount().add(1, { operation: "decrypt" });

		if (ciphertext[0] === CIPHERTEXT_VERSION_V2) {
			if (ciphertext.length < 1 + NONCE_LENGTH + TAG_LENGTH) {
				throw new Error(
					`Ciphertext too short: expected at least ${1 + NONCE_LENGTH + TAG_LENGTH} bytes, got ${ciphertext.length}`,
				);
			}

			return this.decryptWithKey(ciphertext.slice(1), this.deriveV2Key(input.stackId));
		}

		if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
			throw new Error(
				`Ciphertext too short: expected at least ${NONCE_LENGTH + TAG_LENGTH} bytes, got ${ciphertext.length}`,
			);
		}

		return this.decryptWithKey(ciphertext, this.deriveLegacyKey(input.stackFQN));
	}

	private decryptWithKey(ciphertext: Uint8Array, key: Buffer): Uint8Array {
		const nonce = ciphertext.slice(0, NONCE_LENGTH);
		const encrypted = ciphertext.slice(NONCE_LENGTH, ciphertext.length - TAG_LENGTH);
		const tag = ciphertext.slice(ciphertext.length - TAG_LENGTH);

		const decipher = createDecipheriv(ALGORITHM, key, nonce);
		decipher.setAuthTag(tag);

		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		return new Uint8Array(decrypted);
	}

	private deriveLegacyKey(stackFQN: string): Buffer {
		const derived = hkdfSync("sha256", this.masterKey, stackFQN, HKDF_INFO, KEY_LENGTH);
		return Buffer.from(derived);
	}

	private deriveV2Key(stackId: string): Buffer {
		const derived = hkdfSync(
			"sha256",
			this.masterKey,
			stackIdToSalt(stackId),
			HKDF_INFO,
			KEY_LENGTH,
		);
		return Buffer.from(derived);
	}
}

// ============================================================================
// NopCryptoService — passthrough (dev/testing without encryption)
// ============================================================================

export class NopCryptoService implements CryptoService {
	async encrypt(_input: StackCryptoInput, plaintext: Uint8Array): Promise<Uint8Array> {
		return plaintext;
	}

	async decrypt(_input: StackCryptoInput, ciphertext: Uint8Array): Promise<Uint8Array> {
		return ciphertext;
	}
}

function stackIdToSalt(stackId: string): Buffer {
	const salt = Buffer.from(stackId.replace(/-/g, ""), "hex");
	if (salt.length !== STACK_ID_LENGTH) {
		throw new Error(`Invalid stackId: expected ${STACK_ID_LENGTH} bytes, got ${salt.length}`);
	}
	return salt;
}

// ============================================================================
// Dev helper — deterministic master key for development
// ============================================================================

/** Generate a deterministic master key from sha256("procella-dev-encryption-key"). */
export function devMasterKey(): string {
	return createHash("sha256").update("procella-dev-encryption-key").digest("hex");
}
