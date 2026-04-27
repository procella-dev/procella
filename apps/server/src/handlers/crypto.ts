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
import {
	BatchDecryptRequestSchema,
	BatchEncryptRequestSchema,
	DecryptValueRequestSchema,
	EncryptValueRequestSchema,
} from "./schemas.js";

// ============================================================================
// Crypto Handlers
// ============================================================================

const INVALID_JSON_RESPONSE = {
	code: "invalid_request",
	message: "Body is not valid JSON",
} as const;

export function cryptoHandlers(updates: UpdatesService, stacks: StacksService) {
	return {
		encryptValue: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = EncryptValueRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const plaintext = decodeBase64((parseResult.data as EncryptValueRequest).plaintext);
			const ciphertext = await updates.encryptValue(stackInput, plaintext);
			return c.json({ ciphertext: encodeBase64(ciphertext) });
		},

		decryptValue: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = DecryptValueRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const ciphertext = decodeBase64((parseResult.data as DecryptValueRequest).ciphertext);
			const plaintext = await updates.decryptValue(stackInput, ciphertext);
			return c.json({ plaintext: encodeBase64(plaintext) });
		},

		batchEncrypt: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = BatchEncryptRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const plaintexts = ((parseResult.data as BatchEncryptRequest).plaintexts ?? []).map(
				decodeBase64,
			);
			const ciphertexts = await updates.batchEncrypt(stackInput, plaintexts);
			return c.json({
				ciphertexts: ciphertexts.map(encodeBase64),
			});
		},

		batchDecrypt: async (c: Context<Env>) => {
			const stackInput = await resolveAuthorizedStack(c, stacks);
			if (stackInput instanceof Response) return stackInput;
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = BatchDecryptRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const rawCiphertexts = (parseResult.data as BatchDecryptRequest).ciphertexts ?? [];
			const ciphertexts = rawCiphertexts.map(decodeBase64);
			const decrypted = await updates.batchDecrypt(stackInput, ciphertexts);
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
