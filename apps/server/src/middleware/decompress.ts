// @procella/server — Decompress gzip request bodies.
//
// The Pulumi CLI sends checkpoint and event payloads with
// Content-Encoding: gzip. Hono does not auto-decompress request bodies,
// so this middleware transparently inflates them before handlers run.

import { gunzipSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";

const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024; // 128 MB

export function decompress(): MiddlewareHandler {
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
					maxOutputLength: MAX_DECOMPRESSED_BYTES,
				});
			} catch (err) {
				const error = err as { code?: unknown } | null;
				if (error && error.code === "ERR_BUFFER_TOO_LARGE") {
					return c.json({ code: 413, message: "Decompressed payload exceeds size limit" }, 413);
				}
				return c.json({ code: 400, message: "Invalid gzip payload" }, 400);
			}
			const text = new TextDecoder().decode(decompressed);
			const json = JSON.parse(text);
			// biome-ignore lint/suspicious/noExplicitAny: Hono internal body cache
			(c.req as any).bodyCache = {
				json: Promise.resolve(json),
				text: Promise.resolve(text),
			};
		}
		await next();
	};
}
