import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { createBlobStorage, LocalBlobStorage, S3BlobStorage } from "./index";

describe("LocalBlobStorage", () => {
	let basePath: string;
	let storage: LocalBlobStorage;

	beforeAll(() => {
		basePath = join(tmpdir(), `procella-storage-test-${randomUUID()}`);
		storage = new LocalBlobStorage(basePath);
	});

	afterAll(async () => {
		await rm(basePath, { recursive: true, force: true });
	});

	test("put + get roundtrip returns original data", async () => {
		const key = "test/roundtrip.bin";
		const data = new TextEncoder().encode("hello, procella!");

		await storage.put(key, data);
		const result = await storage.get(key);

		expect(result).not.toBeNull();
		expect(result).toEqual(data);
	});

	test("get returns null for non-existent key", async () => {
		const result = await storage.get("does/not/exist.bin");
		expect(result).toBeNull();
	});

	test("exists returns true for existing key, false for missing", async () => {
		const key = "test/exists-check.bin";
		const data = new TextEncoder().encode("exists");

		expect(await storage.exists(key)).toBe(false);
		await storage.put(key, data);
		expect(await storage.exists(key)).toBe(true);
	});

	test("delete removes the blob", async () => {
		const key = "test/to-delete.bin";
		const data = new TextEncoder().encode("delete me");

		await storage.put(key, data);
		expect(await storage.exists(key)).toBe(true);

		await storage.delete(key);
		expect(await storage.exists(key)).toBe(false);
		expect(await storage.get(key)).toBeNull();
	});

	test("delete is idempotent (no error on missing key)", async () => {
		await storage.delete("never/existed.bin");
		// Should not throw — passes if we reach here
	});

	test("put auto-creates nested directories for keys with slashes", async () => {
		const key = "deep/nested/dir/structure/file.bin";
		const data = new TextEncoder().encode("nested");

		await storage.put(key, data);
		const result = await storage.get(key);

		expect(result).not.toBeNull();
		expect(result).toEqual(data);
	});

	test("keys with special characters work", async () => {
		const key = "special/key-with_underscore.and.dots+plus=equals.bin";
		const data = new TextEncoder().encode("special chars");

		await storage.put(key, data);
		const result = await storage.get(key);

		expect(result).not.toBeNull();
		expect(result).toEqual(data);
	});

	test("large blob (1MB) roundtrip works", async () => {
		const key = "test/large-blob.bin";
		const size = 1024 * 1024; // 1MB
		const data = new Uint8Array(size);
		// Fill with non-zero pattern for meaningful verification
		for (let i = 0; i < size; i++) {
			data[i] = i % 256;
		}

		await storage.put(key, data);
		const result = await storage.get(key);

		expect(result).not.toBeNull();
		expect(result?.length).toBe(size);
		expect(result).toEqual(data);
	});
});

describe("LocalBlobStorage with relative basePath", () => {
	let absPath: string;
	let relPath: string;
	let storage: LocalBlobStorage;

	beforeAll(() => {
		absPath = join(tmpdir(), `procella-rel-test-${randomUUID()}`);
		relPath = relative(process.cwd(), absPath);
		storage = new LocalBlobStorage(relPath);
	});

	afterAll(async () => {
		await rm(absPath, { recursive: true, force: true });
	});

	test("put + get works with relative basePath (no path traversal false positive)", async () => {
		const key = "checkpoints/stack-1/update-1/1";
		const data = new TextEncoder().encode("checkpoint data");

		await storage.put(key, data);
		const result = await storage.get(key);

		expect(result).not.toBeNull();
		expect(result).toEqual(data);
	});

	test("path traversal is still rejected", async () => {
		await expect(storage.get("../../etc/passwd")).rejects.toThrow("path traversal detected");
	});
});

describe("S3BlobStorage credentials", () => {
	test("forwards the session token with explicit credentials", async () => {
		const storage = new S3BlobStorage({
			bucket: "test-bucket",
			region: "us-east-1",
			accessKeyId: "test-access-key",
			secretAccessKey: "test-secret-key",
			sessionToken: "test-session-token",
		});
		const client = Reflect.get(storage, "client");
		expect(client).toBeInstanceOf(S3Client);
		if (!(client instanceof S3Client)) {
			throw new Error("S3BlobStorage did not initialize an S3Client");
		}

		await expect(client.config.credentials()).resolves.toMatchObject({
			accessKeyId: "test-access-key",
			secretAccessKey: "test-secret-key",
			sessionToken: "test-session-token",
		});
	});

	test.each([{}, { accessKeyId: "test-access-key" }, { secretAccessKey: "test-secret-key" }])(
		"rejects incomplete credentials for a custom endpoint",
		(credentials) => {
			expect(
				() =>
					new S3BlobStorage({
						bucket: "test-bucket",
						endpoint: "https://storage.example.com",
						...credentials,
					}),
			).toThrow("accessKeyId + secretAccessKey");
		},
	);
});

describe("createBlobStorage factory", () => {
	test("returns LocalBlobStorage for local config", () => {
		const storage = createBlobStorage({
			backend: "local",
			basePath: "/tmp/test",
		});
		expect(storage).toBeInstanceOf(LocalBlobStorage);
	});
});
