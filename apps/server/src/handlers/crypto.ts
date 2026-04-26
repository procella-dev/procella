// @procella/server — Encrypt/decrypt handlers.

import type { StackCryptoInput } from "@procella/crypto";
import type { StacksService } from "@procella/stacks";

import type {
	BatchDecryptRequest,
	BatchEncryptRequest,
	DecryptValueRequest,
	EncryptValueRequest,
} from "@procella/types";
import { StackNotFoundError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// Crypto Handlers
// ============================================================================

export function cryptoHandlers(updates: UpdatesService, stacks: StacksService) {
	return {
		encryptValue: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			const body = await c.req.json<EncryptValueRequest>();
			const plaintext = decodeBase64(body.plaintext);
			const ciphertext = await updates.encryptValue(stackInput, plaintext);
			return c.json({ ciphertext: encodeBase64(ciphertext) });
		},

		decryptValue: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			const body = await c.req.json<DecryptValueRequest>();
			const ciphertext = decodeBase64(body.ciphertext);
			const plaintext = await updates.decryptValue(stackInput, ciphertext);
			return c.json({ plaintext: encodeBase64(plaintext) });
		},

		batchEncrypt: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			const body = await c.req.json<BatchEncryptRequest>();
			const plaintexts = (body.plaintexts ?? []).map(decodeBase64);
			const ciphertexts = await updates.batchEncrypt(stackInput, plaintexts);
			return c.json({
				ciphertexts: ciphertexts.map(encodeBase64),
			});
		},

		batchDecrypt: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			const body = await c.req.json<BatchDecryptRequest>();
			const rawCiphertexts = body.ciphertexts ?? [];
			const ciphertexts = rawCiphertexts.map(decodeBase64);
			const decrypted = await updates.batchDecrypt(stackInput, ciphertexts);
			// Response is a map: base64(ciphertext) → base64(plaintext)
			const plaintexts: Record<string, string> = {};
			for (let i = 0; i < rawCiphertexts.length; i++) {
				const key =
					typeof rawCiphertexts[i] === "string" ? rawCiphertexts[i] : encodeBase64(ciphertexts[i]);
				plaintexts[key] = encodeBase64(decrypted[i]);
			}
			return c.json({ plaintexts });
		},

		logDecryption: (c: Context<Env>) => c.body(null, 200),
	};
}

async function resolveAuthorizedStack(
	c: Context<Env>,
	stacks: StacksService,
): Promise<StackCryptoInput | Response> {
	const caller = c.get("caller");
	const org = param(c, "org");
	const project = param(c, "project");
	const stack = param(c, "stack");

	try {
		const stackInfo = await stacks.getStack(caller.tenantId, org, project, stack);
		return {
			stackId: stackInfo.id,
			stackFQN: `${org}/${project}/${stack}`,
		};
	} catch (error) {
		if (error instanceof StackNotFoundError) {
			return c.json({ code: "stack_not_found" }, 404);
		}
		throw error;
	}
}

// ============================================================================
// Base64 Helpers
// ============================================================================

/** Decode a base64 value (Go JSON encodes []byte as base64). */
function decodeBase64(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (typeof value === "string") {
		return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
	}
	if (Array.isArray(value)) return new Uint8Array(value);
	return new Uint8Array();
}

/** Encode a Uint8Array to base64 string. */
function encodeBase64(data: Uint8Array): string {
	return btoa(String.fromCharCode(...data));
}
