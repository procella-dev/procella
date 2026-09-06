// @procella/server — Decompress gzip request bodies.
//
// The Pulumi CLI sends checkpoint and event payloads with
// Content-Encoding: gzip. Hono does not auto-decompress request bodies,
// so this middleware transparently inflates them before handlers run.

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
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
class PayloadTooLargeError extends Error {}

async function* readCompressedBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	let bytesRead = 0;
	let finished = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				return;
			}
			bytesRead += value.byteLength;
			if (bytesRead > MAX_COMPRESSED_BYTES) {
				throw new PayloadTooLargeError("Compressed payload too large");
			}
			yield value;
		}
	} finally {
		if (!finished) {
			await reader.cancel().catch(() => undefined);
		}
		reader.releaseLock();
	}
}

async function inflateGzip(
	body: ReadableStream<Uint8Array> | null,
	maxDecompressedBytes: number,
): Promise<Buffer> {
	if (!body) {
		throw new Error("Missing gzip payload");
	}

	const compressed = Readable.from(readCompressedBody(body));
	const output = compressed.pipe(createGunzip());
	compressed.on("error", (error) => output.destroy(error));
	const chunks: Buffer[] = [];
	let bytesWritten = 0;
	for await (const chunk of output) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytesWritten += buffer.byteLength;
		if (bytesWritten > maxDecompressedBytes) {
			throw new PayloadTooLargeError("Decompressed payload exceeds size limit");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, bytesWritten);
}

export function decompress(options: DecompressOptions = {}): MiddlewareHandler {
	const maxDecompressedBytes = options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

	return async (c, next) => {
		const encoding = c.req.header("Content-Encoding");
		if (encoding === "gzip") {
			const contentLength = Number(c.req.header("Content-Length"));
			if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_BYTES) {
				return c.json({ code: 413, message: "Compressed payload too large" }, 413);
			}
			let decompressed: Buffer;
			try {
				decompressed = await inflateGzip(c.req.raw.body, maxDecompressedBytes);
			} catch (error) {
				if (error instanceof PayloadTooLargeError) {
					return c.json({ code: 413, message: error.message }, 413);
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

			const headers = new Headers(c.req.raw.headers);
			headers.delete("Content-Encoding");
			headers.delete("Content-Length");
			Object.assign(c.req, {
				raw: new Request(c.req.raw, { body: decompressed as BodyInit, headers }),
				bodyCache: {
					json: Promise.resolve(json),
					text: Promise.resolve(text),
				} satisfies CachedBody,
			});
		}
		await next();
	};
}
