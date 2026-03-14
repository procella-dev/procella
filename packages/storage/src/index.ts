// @procella/storage — Blob storage abstraction (S3 and local filesystem)

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

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
	accessKeyId?: string;
	secretAccessKey?: string;
}

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

// ============================================================================
// LocalBlobStorage
// ============================================================================

export class LocalBlobStorage implements BlobStorage {
	private readonly basePath: string;

	constructor(basePath: string) {
		this.basePath = resolve(basePath);
	}

	private resolvePath(key: string): string {
		const resolved = resolve(this.basePath, key);
		// Prevent path traversal outside basePath
		const rel = relative(this.basePath, resolved);
		if (rel.startsWith("..") || isAbsolute(rel)) {
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
	private readonly bucket: string;

	constructor(config: Omit<S3StorageConfig, "backend">) {
		this.bucket = config.bucket;

		// Custom endpoints (MinIO, R2) require explicit credentials — the AWS SDK
		// default credential chain won't work. Fail fast on misconfiguration.
		if (config.endpoint && (!config.accessKeyId || !config.secretAccessKey)) {
			throw new Error(
				"S3 credentials (accessKeyId + secretAccessKey) are required when using a custom endpoint",
			);
		}

		this.client = new S3Client({
			...(config.accessKeyId && config.secretAccessKey
				? {
						credentials: {
							accessKeyId: config.accessKeyId,
							secretAccessKey: config.secretAccessKey,
						},
					}
				: {}),
			endpoint: config.endpoint,
			region: config.region,
			forcePathStyle: !!config.endpoint,
		});
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);

			if (!response.Body) {
				return null;
			}

			return await S3BlobStorage.bodyToUint8Array(response.Body);
		} catch (err: unknown) {
			if (
				isS3ErrorName(err, "NoSuchKey") ||
				isS3ErrorName(err, "NotFound") ||
				(isS3Error(err) && err.$metadata?.httpStatusCode === 404)
			) {
				return null;
			}

			throw err;
		}
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: data,
			}),
		);
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		);
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: key,
				}),
			);
			return true;
		} catch (err: unknown) {
			if (
				isS3ErrorName(err, "NotFound") ||
				(isS3Error(err) && err.$metadata?.httpStatusCode === 404)
			) {
				return false;
			}

			throw err;
		}
	}

	private static async bodyToUint8Array(body: unknown): Promise<Uint8Array> {
		if (isTransformableBody(body)) {
			const bytes = await body.transformToByteArray();
			return new Uint8Array(bytes);
		}

		if (body instanceof Uint8Array) {
			return body;
		}

		if (body instanceof ReadableStream) {
			const arrayBuffer = await new Response(body).arrayBuffer();
			return new Uint8Array(arrayBuffer);
		}

		if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
			const chunks: Uint8Array[] = [];
			for await (const chunk of body as AsyncIterable<unknown>) {
				if (chunk instanceof Uint8Array) {
					chunks.push(chunk);
				} else if (typeof chunk === "string") {
					chunks.push(new TextEncoder().encode(chunk));
				} else {
					chunks.push(new Uint8Array(chunk as ArrayBufferLike));
				}
			}

			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const result = new Uint8Array(totalLength);
			let offset = 0;

			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}

			return result;
		}

		throw new Error("Unsupported S3 object body type");
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

function isS3Error(
	err: unknown,
): err is { name?: string; $metadata?: { httpStatusCode?: number } } {
	return typeof err === "object" && err !== null && "name" in err;
}

function isS3ErrorName(err: unknown, name: string): boolean {
	return isS3Error(err) && err.name === name;
}

interface TransformableBody {
	transformToByteArray(): Promise<Uint8Array>;
}

function isTransformableBody(body: unknown): body is TransformableBody {
	return (
		typeof body === "object" &&
		body !== null &&
		"transformToByteArray" in body &&
		typeof body.transformToByteArray === "function"
	);
}
