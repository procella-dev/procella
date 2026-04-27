// @procella/server — Decompress gzip request bodies.
//
// The Pulumi CLI sends checkpoint and event payloads with
// Content-Encoding: gzip. Hono does not auto-decompress request bodies,
// so this middleware transparently inflates them before handlers run.

import { gunzipSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import { MAX_JSON_DEPTH, MAX_STRING_LENGTH } from "../handlers/schemas.js";

const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024; // 32 MB

interface DecompressOptions {
	maxDecompressedBytes?: number;
}

interface CachedBody {
	json: Promise<unknown>;
	text: Promise<string>;
}

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function validateJsonBounds(
	value: unknown,
	depth = 1,
	path: (string | number)[] = [],
): string | null {
	if (depth > MAX_JSON_DEPTH) {
		return `${formatPath(path)} exceeds maximum depth of ${MAX_JSON_DEPTH}`;
	}

	if (typeof value === "string") {
		if (value.length > MAX_STRING_LENGTH) {
			return `${formatPath(path)} exceeds maximum string length of ${MAX_STRING_LENGTH}`;
		}
		return null;
	}

	if (value === null || typeof value !== "object") {
		return null;
	}

	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const error = validateJsonBounds(item, depth + 1, [...path, index]);
			if (error) return error;
		}
		return null;
	}

	for (const [key, nestedValue] of Object.entries(value)) {
		if (FORBIDDEN_JSON_KEYS.has(key)) {
			return `${formatPath([...path, key])} uses forbidden JSON key`;
		}
		const error = validateJsonBounds(nestedValue, depth + 1, [...path, key]);
		if (error) return error;
	}

	return null;
}

function formatPath(path: (string | number)[]): string {
	if (path.length === 0) return "body";
	return `body.${path.join(".")}`;
}

export function decompress(options: DecompressOptions = {}): MiddlewareHandler {
	const maxDecompressedBytes = options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

	return async (c, next) => {
		const encoding = c.req.header("Content-Encoding");
		if (encoding === "gzip") {
			const compressed = await c.req.arrayBuffer();
			if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
				return c.json({ code: 413, message: "Compressed payload too large" }, 413);
			}
			let decompressed: Buffer;
			try {
				decompressed = gunzipSync(Buffer.from(compressed), {
					maxOutputLength: maxDecompressedBytes,
				});
			} catch (err) {
				const error = err as { code?: unknown } | null;
				if (error && error.code === "ERR_BUFFER_TOO_LARGE") {
					return c.json({ code: 413, message: "Decompressed payload exceeds size limit" }, 413);
				}
				return c.json({ code: 400, message: "Invalid gzip payload" }, 400);
			}
			const text = new TextDecoder().decode(decompressed);
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				return c.json({ code: 400, message: "Invalid JSON payload" }, 400);
			}

			const boundsError = validateJsonBounds(json);
			if (boundsError) {
				return c.json({ code: 400, message: boundsError }, 400);
			}

			Object.assign(c.req, {
				bodyCache: {
					json: Promise.resolve(json),
					text: Promise.resolve(text),
				} satisfies CachedBody,
			});
		}
		await next();
	};
}
