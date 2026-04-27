import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { decompress } from "./decompress.js";

describe("decompress middleware", () => {
	function createApp(maxDecompressedBytes?: number) {
		const app = new Hono();
		app.use("*", decompress(maxDecompressedBytes ? { maxDecompressedBytes } : undefined));
		app.post("/test", async (c) => {
			const body = await c.req.json();
			return c.json(body);
		});
		return app;
	}

	function createSizedPayload(bytes: number): string {
		const chunkSize = 256 * 1024;
		const chunks: string[] = [];
		let payload = JSON.stringify({ data: chunks });

		while (Buffer.byteLength(payload) < bytes) {
			const remaining = bytes - Buffer.byteLength(payload);
			const nextChunkSize = Math.min(chunkSize, Math.max(1, remaining));
			chunks.push("x".repeat(nextChunkSize));
			payload = JSON.stringify({ data: chunks });
		}

		return payload;
	}

	test("passes through non-gzip requests unchanged", async () => {
		const app = createApp();
		const res = await app.request("/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hello: "world" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.hello).toBe("world");
	});

	test("decompresses gzip request body", async () => {
		const app = createApp();
		const payload = JSON.stringify({ key: "compressed-value" });
		const compressed = gzipSync(Buffer.from(payload));

		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.key).toBe("compressed-value");
	});

	test("returns 400 for invalid gzip data", async () => {
		const app = createApp();
		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: new Uint8Array([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff]),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe(400);
	});

	test("returns 413 when compressed payload exceeds 20MB", async () => {
		const app = createApp();
		// Create a buffer just over 20MB
		const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
		// Add gzip magic bytes to make it look like gzip
		oversized[0] = 0x1f;
		oversized[1] = 0x8b;

		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: oversized,
		});
		expect(res.status).toBe(413);
		const body = await res.json();
		expect(body.message).toContain("too large");
	});

	test("handles nested JSON objects in gzip", async () => {
		const app = createApp();
		const payload = JSON.stringify({
			resources: [{ urn: "urn:test:Resource", type: "test:index:Resource" }],
		});
		const compressed = gzipSync(Buffer.from(payload));

		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.resources).toBeArray();
		expect(body.resources[0].urn).toBe("urn:test:Resource");
	});

	test("accepts 30 MiB decompressed payload with default cap", async () => {
		const app = createApp();
		const compressed = gzipSync(Buffer.from(createSizedPayload(30 * 1024 * 1024)));

		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		});

		expect(res.status).toBe(200);
	});

	test("rejects 33 MiB decompressed payload with default cap", async () => {
		const app = createApp();
		const compressed = gzipSync(Buffer.from(createSizedPayload(33 * 1024 * 1024)));

		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		});

		expect(res.status).toBe(413);
	});

	test("accepts 50 MiB decompressed payload with override cap", async () => {
		const app = createApp(100 * 1024 * 1024);
		const compressed = gzipSync(Buffer.from(createSizedPayload(50 * 1024 * 1024)));

		const res = await app.request("/test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: compressed,
		});

		expect(res.status).toBe(200);
	});
});
