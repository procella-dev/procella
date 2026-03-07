import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatConfigErrors, loadConfig, tryLoadConfig } from "./index.js";

// Save original env and restore after each test
let savedEnv: Record<string, string | undefined>;

function setMinimalEnv() {
	Bun.env.STRATA_DATABASE_URL = "postgres://strata:strata@localhost:5432/strata?sslmode=disable";
	Bun.env.STRATA_AUTH_MODE = "dev";
	Bun.env.STRATA_DEV_AUTH_TOKEN = "devtoken123";
}

function clearStrataEnv() {
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("STRATA_")) {
			delete Bun.env[key];
		}
	}
}

beforeEach(() => {
	savedEnv = {};
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("STRATA_") || key.startsWith("AWS_")) {
			savedEnv[key] = Bun.env[key];
		}
	}
});

afterEach(() => {
	clearStrataEnv();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value !== undefined) {
			Bun.env[key] = value;
		}
	}
});

describe("@strata/config", () => {
	describe("loadConfig", () => {
		test("loads minimal dev config with defaults", () => {
			clearStrataEnv();
			setMinimalEnv();
			const config = loadConfig();
			expect(config.listenAddr).toBe(":8080");
			expect(config.databaseUrl).toBe(
				"postgres://strata:strata@localhost:5432/strata?sslmode=disable",
			);
			expect(config.authMode).toBe("dev");
			expect(config.devAuthToken).toBe("devtoken123");
			expect(config.devUserLogin).toBe("dev-user");
			expect(config.devOrgLogin).toBe("dev-org");
			expect(config.blobBackend).toBe("local");
			expect(config.blobLocalPath).toBe("./data/blobs");
		});

		test("loads full config with all overrides", () => {
			clearStrataEnv();
			setMinimalEnv();
			Bun.env.STRATA_LISTEN_ADDR = ":9090";
			Bun.env.STRATA_DEV_USER_LOGIN = "custom-user";
			Bun.env.STRATA_DEV_ORG_LOGIN = "custom-org";
			Bun.env.STRATA_BLOB_BACKEND = "s3";
			Bun.env.STRATA_BLOB_S3_BUCKET = "my-bucket";
			Bun.env.STRATA_BLOB_S3_ENDPOINT = "http://localhost:9000";
			Bun.env.STRATA_ENCRYPTION_KEY = "a".repeat(64);

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
			clearStrataEnv();
			Bun.env.STRATA_AUTH_MODE = "dev";
			Bun.env.STRATA_DEV_AUTH_TOKEN = "token";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when dev mode lacks auth token", () => {
			clearStrataEnv();
			Bun.env.STRATA_DATABASE_URL = "postgres://localhost:5432/strata?sslmode=disable";
			Bun.env.STRATA_AUTH_MODE = "dev";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when descope mode lacks project ID", () => {
			clearStrataEnv();
			Bun.env.STRATA_DATABASE_URL = "postgres://localhost:5432/strata?sslmode=disable";
			Bun.env.STRATA_AUTH_MODE = "descope";
			expect(() => loadConfig()).toThrow();
		});

		test("throws when s3 backend lacks bucket", () => {
			clearStrataEnv();
			setMinimalEnv();
			Bun.env.STRATA_BLOB_BACKEND = "s3";
			expect(() => loadConfig()).toThrow();
		});

		test("throws on invalid encryption key format", () => {
			clearStrataEnv();
			setMinimalEnv();
			Bun.env.STRATA_ENCRYPTION_KEY = "not-hex";
			expect(() => loadConfig()).toThrow();
		});
	});

	describe("tryLoadConfig", () => {
		test("returns ok result on valid config", () => {
			clearStrataEnv();
			setMinimalEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.authMode).toBe("dev");
			}
		});

		test("returns error result on invalid config", () => {
			clearStrataEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.issues.length).toBeGreaterThan(0);
			}
		});
	});

	describe("formatConfigErrors", () => {
		test("formats errors as readable lines", () => {
			clearStrataEnv();
			const result = tryLoadConfig();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const formatted = formatConfigErrors(result.error);
				expect(formatted).toContain("databaseUrl");
			}
		});
	});
});
