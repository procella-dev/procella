// @procella/storage — Blob storage abstraction (S3 and local filesystem)

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { S3Client } from "bun";

// ============================================================================
// Interface
// ============================================================================

export interface BlobStorage {
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, data: Uint8Array): Promise<void>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
}

// ============================================================================
// Config
// ============================================================================

export interface LocalStorageConfig {
	backend: "local";
	basePath: string;
}

export interface S3StorageConfig {
	backend: "s3";
	bucket: string;
	endpoint?: string;
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

// ============================================================================
// LocalBlobStorage
// ============================================================================

export class LocalBlobStorage implements BlobStorage {
	private readonly basePath: string;

	constructor(basePath: string) {
		this.basePath = basePath;
	}

	private resolvePath(key: string): string {
		const resolved = normalize(join(this.basePath, key));
		// Prevent path traversal outside basePath
		if (!resolved.startsWith(this.basePath)) {
			throw new Error("Invalid key: path traversal detected");
		}
		return resolved;
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const filePath = this.resolvePath(key);
			const buffer = await readFile(filePath);
			return new Uint8Array(buffer);
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") {
				return null;
			}
			throw err;
		}
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		const filePath = this.resolvePath(key);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, data);
	}

	async delete(key: string): Promise<void> {
		try {
			const filePath = this.resolvePath(key);
			await rm(filePath, { force: true });
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") {
				return;
			}
			throw err;
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			const filePath = this.resolvePath(key);
			await stat(filePath);
			return true;
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") {
				return false;
			}
			throw err;
		}
	}
}

// ============================================================================
// S3BlobStorage
// ============================================================================

export class S3BlobStorage implements BlobStorage {
	private readonly client: S3Client;

	constructor(config: Omit<S3StorageConfig, "backend">) {
		this.client = new S3Client({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			bucket: config.bucket,
			endpoint: config.endpoint,
			region: config.region,
		});
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const bytes = await this.client.file(key).bytes();
			return new Uint8Array(bytes);
		} catch {
			return null;
		}
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		await this.client.file(key).write(data);
	}

	async delete(key: string): Promise<void> {
		await this.client.file(key).delete();
	}

	async exists(key: string): Promise<boolean> {
		return this.client.file(key).exists();
	}
}

// ============================================================================
// Factory
// ============================================================================

export function createBlobStorage(config: StorageConfig): BlobStorage {
	switch (config.backend) {
		case "local":
			return new LocalBlobStorage(config.basePath);
		case "s3":
			return new S3BlobStorage({
				bucket: config.bucket,
				endpoint: config.endpoint,
				region: config.region,
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			});
	}
}

// ============================================================================
// Helpers
// ============================================================================

interface NodeError extends Error {
	code?: string;
}

function isNodeError(err: unknown): err is NodeError {
	return err instanceof Error && "code" in err;
}
