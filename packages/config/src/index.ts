// @procella/config — Environment configuration with Zod validation.
//
// All configuration is sourced from environment variables (PROCELLA_* prefix).
// Zod schemas validate and parse at startup — fail fast on misconfiguration.
// Bun.env is used directly (native .env file support, no dotenv needed).

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
				message: "PROCELLA_DEV_AUTH_TOKEN is required when PROCELLA_AUTH_MODE=dev",
				path: ["devAuthToken"],
			});
		}
		if (data.authMode === "descope" && !data.descopeProjectId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "PROCELLA_DESCOPE_PROJECT_ID is required when PROCELLA_AUTH_MODE=descope",
				path: ["descopeProjectId"],
			});
		}
		if (data.blobBackend === "s3" && !data.blobS3Bucket) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "PROCELLA_BLOB_S3_BUCKET is required when PROCELLA_BLOB_BACKEND=s3",
				path: ["blobS3Bucket"],
			});
		}
		if (data.authMode !== "dev" && !data.encryptionKey) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"PROCELLA_ENCRYPTION_KEY is required in production (non-dev auth mode). Must be 64 hex chars (32 bytes).",
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

/** Map PROCELLA_* env vars to config object shape. */
function envToConfig(): Record<string, unknown> {
	const env = Bun.env;
	return {
		listenAddr: env.PROCELLA_LISTEN_ADDR,
		databaseUrl: env.PROCELLA_DATABASE_URL,
		authMode: env.PROCELLA_AUTH_MODE,
		devAuthToken: env.PROCELLA_DEV_AUTH_TOKEN,
		devUserLogin: env.PROCELLA_DEV_USER_LOGIN,
		devOrgLogin: env.PROCELLA_DEV_ORG_LOGIN,
		descopeProjectId: env.PROCELLA_DESCOPE_PROJECT_ID,
		descopeManagementKey: env.PROCELLA_DESCOPE_MANAGEMENT_KEY,
		blobBackend: env.PROCELLA_BLOB_BACKEND,
		blobLocalPath: env.PROCELLA_BLOB_LOCAL_PATH,
		blobS3Bucket: env.PROCELLA_BLOB_S3_BUCKET,
		blobS3Endpoint: env.PROCELLA_BLOB_S3_ENDPOINT,
		blobS3Region: env.PROCELLA_BLOB_S3_REGION,
		encryptionKey: env.PROCELLA_ENCRYPTION_KEY,
		corsOrigins: env.PROCELLA_CORS_ORIGINS,
	};
}

/**
 * Load and validate configuration from environment variables.
 * Throws a descriptive ZodError on validation failure — call at startup.
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
 */
export function formatConfigErrors(error: z.ZodError): string {
	return error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
}
