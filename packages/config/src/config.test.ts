import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatConfigErrors, loadConfig, tryLoadConfig } from "./index.js";

// Save original env and restore after each test
let savedEnv: Record<string, string | undefined>;

function setMinimalEnv() {
	Bun.env.PROCELLA_DATABASE_URL =
		"postgres://procella:procella@localhost:5432/procella?sslmode=disable";
	Bun.env.PROCELLA_AUTH_MODE = "dev";
	Bun.env.PROCELLA_DEV_AUTH_TOKEN = "devtoken123";
}

function clearProcellaEnv() {
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("PROCELLA_")) {
			delete Bun.env[key];
		}
	}
}

beforeEach(() => {
	savedEnv = {};
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("PROCELLA_") || key.startsWith("AWS_")) {
			savedEnv[key] = Bun.env[key];
		}
	}
});

afterEach(() => {
	clearProcellaEnv();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value !== undefined) {
			Bun.env[key] = value;
		}
	}
});

describe("@procella/config", () => {
	describe("loadConfig", () => {
		test("loads minimal dev config with defaults", () => {
			clearProcellaEnv();
			setMinimalEnv();
			const config = loadConfig();
			expect(config.listenAddr).toBe(":9090");
			expect(config.databaseUrl).toBe(
				"postgres://procella:procella@localhost:5432/procella?sslmode=disable",
			);
			expect(config.authMode).toBe("dev");
			expect(config.devAuthToken).toBe("devtoken123");
			expect(config.devUserLogin).toBe("dev-user");
			expect(config.devOrgLogin).toBe("dev-org");
			expect(config.blobBackend).toBe("local");
			expect(config.blobLocalPath).toBe("./data/blobs");
		});

		test("loads full config with all overrides", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_LISTEN_ADDR = ":9090";
			Bun.env.PROCELLA_DEV_USER_LOGIN = "custom-user";
			Bun.env.PROCELLA_DEV_ORG_LOGIN = "custom-org";
			Bun.env.PROCELLA_BLOB_BACKEND = "s3";
			Bun.env.PROCELLA_BLOB_S3_BUCKET = "my-bucket";
			Bun.env.PROCELLA_BLOB_S3_ENDPOINT = "http://localhost:9000";
			Bun.env.PROCELLA_ENCRYPTION_KEY = "a".repeat(64);

			const config = loadConfig();
			expect(config.listenAddr).toBe(":9090");
			expect(config.devUserLogin).toBe("custom-user");
			expect(config.devOrgLogin).toBe("custom-org");
			expect(config.blobBackend).toBe("s3");
			expect(config.blobS3Bucket).toBe("my-bucket");
			expect(config.blobS3Endpoint).toBe("http://localhost:9000");
			expect(config.encryptionKey).toBe("a".repeat(64));
		});

		test("throws on missing database URL", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_AUTH_MODE = "dev";
			Bun.env.PROCELLA_DEV_AUTH_TOKEN = "token";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when dev mode lacks auth token", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "dev";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when descope mode lacks project ID", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "descope";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when s3 backend lacks bucket", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_BLOB_BACKEND = "s3";
			expect(() => loadConfig()).toThrow();
		});

		test("throws on invalid encryption key format", () => {
			clearProcellaEnv();
			setMinimalEnv();
			Bun.env.PROCELLA_ENCRYPTION_KEY = "not-hex";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when non-dev mode lacks encryption key", () => {
			clearProcellaEnv();
			Bun.env.PROCELLA_DATABASE_URL = "postgres://localhost:5432/procella?sslmode=disable";
			Bun.env.PROCELLA_AUTH_MODE = "descope";
			Bun.env.PROCELLA_DESCOPE_PROJECT_ID = "P3test";
			expect(() => loadConfig()).toThrow(/Required in production/);
		});

		test("allows missing encryption key in dev mode", () => {
			clearProcellaEnv();
			setMinimalEnv();
			// No PROCELLA_ENCRYPTION_KEY set — should be fine in dev
			const config = loadConfig();
			expect(config.encryptionKey).toBeUndefined();
		});
	});

	describe("tryLoadConfig", () => {
		test("returns ok result on valid config", () => {
			clearProcellaEnv();
			setMinimalEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.authMode).toBe("dev");
			}
		});

		test("returns error result on invalid config", () => {
			clearProcellaEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.issues.length).toBeGreaterThan(0);
			}
		});
	});

	describe("formatConfigErrors", () => {
		test("formats errors with PROCELLA_* env var names", () => {
			clearProcellaEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const formatted = formatConfigErrors(result.error);
				expect(formatted).toContain("PROCELLA_DATABASE_URL");
				expect(formatted).toContain("✗");
			}
		});
	});
});
