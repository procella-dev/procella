// @procella/config — Environment configuration with Zod validation.
//
// All configuration is sourced from environment variables (PROCELLA_* prefix).
// Zod schemas validate and parse at startup — fail fast on misconfiguration.
// Uses process.env for portability across Bun, Node.js, and Vercel.

import { z } from "zod";

// ============================================================================
// Schema
// ============================================================================

const authModeSchema = z.enum(["dev", "descope"]);
const blobBackendSchema = z.enum(["local", "s3"]);

const configSchema = z
	.object({
		// Server
		listenAddr: z.string().default(":9090"),

		// Database
		databaseUrl: z.string().url(),
		databasePoolMax: z.coerce.number().int().min(1).max(100).default(10),

		// Auth
		authMode: authModeSchema.default("dev"),
		devAuthToken: z.string().optional(),
		devUserLogin: z.string().default("dev-user"),
		devOrgLogin: z.string().default("dev-org"),
		descopeProjectId: z.string().optional(),
		descopeManagementKey: z.string().optional(),

		// Blob storage
		blobBackend: blobBackendSchema.default("local"),
		blobLocalPath: z.string().default("./data/blobs"),
		blobS3Bucket: z.string().optional(),
		blobS3Endpoint: z.string().url().optional(),
		blobS3Region: z.string().default("us-east-1"),

		// Encryption
		encryptionKey: z
			.string()
			.regex(/^[0-9a-fA-F]{64}$/, "Must be 64 hex chars (32 bytes)")
			.optional(),

		// Delta checkpoints
		deltaCheckpointCutoffBytes: z.coerce.number().int().min(0).default(1_048_576),

		// CORS
		corsOrigins: z
			.string()
			.transform((s) => s.split(",").map((o) => o.trim()))
			.optional(),
	})
	.superRefine((data, ctx) => {
		if (data.authMode === "dev" && !data.devAuthToken) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required when PROCELLA_AUTH_MODE=dev",
				path: ["devAuthToken"],
			});
		}
		if (data.authMode === "descope" && !data.descopeProjectId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required when PROCELLA_AUTH_MODE=descope",
				path: ["descopeProjectId"],
			});
		}
		if (data.blobBackend === "s3" && !data.blobS3Bucket) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required when PROCELLA_BLOB_BACKEND=s3",
				path: ["blobS3Bucket"],
			});
		}
		if (data.authMode !== "dev" && !data.encryptionKey) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Required in production (non-dev auth mode). Must be 64 hex chars (32 bytes).",
				path: ["encryptionKey"],
			});
		}
	});

// ============================================================================
// Types
// ============================================================================

export type Config = z.infer<typeof configSchema>;
export type AuthMode = z.infer<typeof authModeSchema>;
export type BlobBackend = z.infer<typeof blobBackendSchema>;

// ============================================================================
// Loader
// ============================================================================

const envMapping = {
	listenAddr: "PROCELLA_LISTEN_ADDR",
	databaseUrl: "PROCELLA_DATABASE_URL",
	databasePoolMax: "PROCELLA_DATABASE_POOL_MAX",
	authMode: "PROCELLA_AUTH_MODE",
	devAuthToken: "PROCELLA_DEV_AUTH_TOKEN",
	devUserLogin: "PROCELLA_DEV_USER_LOGIN",
	devOrgLogin: "PROCELLA_DEV_ORG_LOGIN",
	descopeProjectId: "PROCELLA_DESCOPE_PROJECT_ID",
	descopeManagementKey: "PROCELLA_DESCOPE_MANAGEMENT_KEY",
	blobBackend: "PROCELLA_BLOB_BACKEND",
	blobLocalPath: "PROCELLA_BLOB_LOCAL_PATH",
	blobS3Bucket: "PROCELLA_BLOB_S3_BUCKET",
	blobS3Endpoint: "PROCELLA_BLOB_S3_ENDPOINT",
	blobS3Region: "PROCELLA_BLOB_S3_REGION",
	encryptionKey: "PROCELLA_ENCRYPTION_KEY",
	deltaCheckpointCutoffBytes: "PROCELLA_DELTA_CHECKPOINT_CUTOFF_BYTES",
	corsOrigins: "PROCELLA_CORS_ORIGINS",
} as const;

function envToConfig(): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, envVar] of Object.entries(envMapping)) {
		result[key] = process.env[envVar];
	}
	return result;
}

/**
 * Load and validate configuration from environment variables.
 * Throws a ZodError on validation failure — call at startup.
 */
export function loadConfig(): Config {
	return configSchema.parse(envToConfig());
}

/**
 * Load config, returning a result tuple instead of throwing.
 * Useful for CLI tools that want to display errors nicely.
 */
export function tryLoadConfig(): { ok: true; config: Config } | { ok: false; error: z.ZodError } {
	const result = configSchema.safeParse(envToConfig());
	if (result.success) {
		return { ok: true, config: result.data };
	}
	return { ok: false, error: result.error };
}

/**
 * Format a ZodError into human-readable config error messages.
 * Maps camelCase config keys to their PROCELLA_* env var names.
 */
export function formatConfigErrors(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const key = issue.path.join(".");
			const envVar = envMapping[key as keyof typeof envMapping];
			const label = envVar ? `${envVar}` : key;
			return `  ✗ ${label}: ${issue.message}`;
		})
		.join("\n");
}
