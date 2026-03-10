// @procella/server — Decompress gzip request bodies.
//
// The Pulumi CLI sends checkpoint and event payloads with
// Content-Encoding: gzip. Hono does not auto-decompress request bodies,
// so this middleware transparently inflates them before handlers run.

import type { MiddlewareHandler } from "hono";

/** Decompress gzip request bodies so downstream handlers can use c.req.json(). */
export function decompress(): MiddlewareHandler {
	return async (c, next) => {
		const encoding = c.req.header("Content-Encoding");
		if (encoding === "gzip") {
			const compressed = await c.req.arrayBuffer();
			const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
			const text = new TextDecoder().decode(decompressed);
			const json = JSON.parse(text);
			// Hono's #cachedBody expects Promise values in bodyCache
			// biome-ignore lint/suspicious/noExplicitAny: Hono internal body cache
			(c.req as any).bodyCache = {
				json: Promise.resolve(json),
				text: Promise.resolve(text),
			};
		}
		await next();
	};
}
