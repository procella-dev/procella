// E2E — Descope auth mode: real JWT validation, test users via management SDK.
//
// Run via: bun run e2e:descope
//
// Requires env vars:
//   PROCELLA_DESCOPE_PROJECT_ID      — Descope project ID
//   PROCELLA_DESCOPE_MANAGEMENT_KEY  — Descope management key
//   PROCELLA_DATABASE_URL            — Postgres connection string
//   PROCELLA_ENCRYPTION_KEY          — 64 hex chars (AES-256 master key)
//
// Optional:
//   PROCELLA_E2E_DESCOPE_TENANT_ID   — Descope tenant ID to use for the test
//                                      user (defaults to project ID)
//
// Auto-skipped when required env vars are absent.
// This test manages its own server lifecycle (separate port from the main e2e
// suite) so it can run in Descope auth mode without interfering with dev-mode
// tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import DescopeClient from "@descope/node-sdk";
import type { Subprocess } from "bun";
import {
	cleanupDir,
	createPulumiHome,
	ensureDeps,
	pulumi,
	resetDatabase,
	stopServer,
	TEST_DB_URL,
	truncateTables,
} from "./helpers.js";

// ============================================================================
// Configuration
// ============================================================================

const DESCOPE_PROJECT_ID = process.env.PROCELLA_DESCOPE_PROJECT_ID ?? "";
const DESCOPE_MANAGEMENT_KEY = process.env.PROCELLA_DESCOPE_MANAGEMENT_KEY ?? "";
const ENCRYPTION_KEY = process.env.PROCELLA_ENCRYPTION_KEY ?? "";

// Run on a different port so this test can coexist with the main e2e suite
const DESCOPE_PORT = 18_081;
const DESCOPE_BACKEND_URL = `http://127.0.0.1:${DESCOPE_PORT}`;
const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

const SKIP = !DESCOPE_PROJECT_ID || !DESCOPE_MANAGEMENT_KEY || !ENCRYPTION_KEY;
const describe_descope = SKIP ? describe.skip : describe;

// Unique suffix per run to prevent collisions across parallel CI jobs
const RUN_ID = Date.now().toString(36);
const TEST_LOGIN_ID = `procella-e2e-${RUN_ID}@test.invalid`;

// ============================================================================
// Descope management helpers
// ============================================================================

/**
 * Create a Descope test user with admin role, mint a short-lived access key,
 * and return the cleartext key to use as PULUMI_ACCESS_TOKEN.
 */
async function setupTestUser(
	sdk: ReturnType<typeof DescopeClient>,
	tenantId: string,
): Promise<string> {
	// Create a test user (flagged test: true — eligible for deleteAllTestUsers)
	await sdk.management.user.createTestUser(TEST_LOGIN_ID, {
		email: TEST_LOGIN_ID,
		verifiedEmail: true,
		displayName: "Procella E2E Test User",
		userTenants: [{ tenantId, roleNames: ["admin"] }],
	});

	// Mint a 10-minute access key bound to the user's tenant + roles
	const expireTime = Math.floor(Date.now() / 1000) + 600;
	const resp = await sdk.management.accessKey.create(
		`procella-e2e-${RUN_ID}`,
		expireTime,
		undefined,
		[{ tenantId, roleNames: ["admin"] }],
	);

	if (!resp.data?.cleartext) {
		throw new Error("Descope accessKey.create returned no cleartext");
	}
	return resp.data.cleartext;
}

/** Start Procella on DESCOPE_PORT in Descope auth mode. */
async function startDescopeServer(): Promise<Subprocess> {
	const cleanEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith("PROCELLA_") || k.startsWith("AWS_")) continue;
		if (v !== undefined) cleanEnv[k] = v;
	}

	const proc = Bun.spawn(["bun", "run", "apps/server/src/index.ts"], {
		env: {
			...cleanEnv,
			PROCELLA_LISTEN_ADDR: `:${DESCOPE_PORT}`,
			PROCELLA_DATABASE_URL: TEST_DB_URL,
			PROCELLA_AUTH_MODE: "descope",
			PROCELLA_DESCOPE_PROJECT_ID: DESCOPE_PROJECT_ID,
			PROCELLA_DESCOPE_MANAGEMENT_KEY: DESCOPE_MANAGEMENT_KEY,
			PROCELLA_ENCRYPTION_KEY: ENCRYPTION_KEY,
			PROCELLA_BLOB_BACKEND: "local",
			PROCELLA_BLOB_LOCAL_PATH: "./data/e2e-blobs-descope",
		},
		cwd: PROJECT_ROOT,
		stdout: "ignore",
		stderr: "inherit",
	});

	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${DESCOPE_BACKEND_URL}/healthz`);
			if (r.ok) return proc;
		} catch {
			/* retry */
		}
		await Bun.sleep(250);
	}
	proc.kill();
	throw new Error(`Descope server did not become healthy on :${DESCOPE_PORT}`);
}

// ============================================================================
// Tests
// ============================================================================

describe_descope("Descope auth mode", () => {
	let server: Subprocess;
	let sdk: ReturnType<typeof DescopeClient>;
	let accessKey: string;
	let pulumiHome: string;

	const tenantId = process.env.PROCELLA_E2E_DESCOPE_TENANT_ID ?? DESCOPE_PROJECT_ID;

	beforeAll(async () => {
		await ensureDeps();
		await resetDatabase();

		sdk = DescopeClient({
			projectId: DESCOPE_PROJECT_ID,
			managementKey: DESCOPE_MANAGEMENT_KEY,
		});

		// Wipe any test users left behind by previous interrupted runs
		await sdk.management.user.deleteAllTestUsers().catch(() => {});

		// Create user + access key
		accessKey = await setupTestUser(sdk, tenantId);

		// Start server in Descope mode on the dedicated port
		server = await startDescopeServer();
		pulumiHome = await createPulumiHome();
	});

	afterAll(async () => {
		await sdk?.management.user.deleteAllTestUsers().catch(() => {});
		await truncateTables().catch(() => {});
		if (server) await stopServer(server);
		if (pulumiHome) await cleanupDir(pulumiHome);
	});

	// --- Authentication ---

	test("valid Descope access key is accepted", async () => {
		const res = await fetch(`${DESCOPE_BACKEND_URL}/api/user`, {
			headers: {
				Authorization: `token ${accessKey}`,
				Accept: "application/vnd.pulumi+8",
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body.name).toBe("string");
	});

	test("invalid token is rejected with 401", async () => {
		const res = await fetch(`${DESCOPE_BACKEND_URL}/api/user`, {
			headers: {
				Authorization: "token not-a-real-key",
				Accept: "application/vnd.pulumi+8",
			},
		});
		expect(res.status).toBe(401);
	});

	test("dev-mode static token is rejected in Descope mode", async () => {
		const res = await fetch(`${DESCOPE_BACKEND_URL}/api/user`, {
			headers: {
				Authorization: "token devtoken123",
				Accept: "application/vnd.pulumi+8",
			},
		});
		expect(res.status).toBe(401);
	});

	// --- Pulumi CLI ---

	test("pulumi login with Descope access key succeeds", async () => {
		const result = await pulumi(["login", DESCOPE_BACKEND_URL], {
			pulumiHome,
			env: { PULUMI_ACCESS_TOKEN: accessKey },
		});
		expect(result.exitCode).toBe(0);
	});

	// --- Stack operations ---

	test("stack create / get / delete works with Descope auth", async () => {
		const headers = {
			Authorization: `token ${accessKey}`,
			Accept: "application/vnd.pulumi+8",
		};
		const base = `${DESCOPE_BACKEND_URL}/api/stacks/dev-org/descope-e2e/main`;

		const create = await fetch(base, { method: "POST", headers });
		expect(create.status).toBe(200);

		const get = await fetch(base, { headers });
		expect(get.status).toBe(200);
		const stack = (await get.json()) as Record<string, unknown>;
		expect(stack.stackName).toBe("main");

		const del = await fetch(base, { method: "DELETE", headers });
		expect(del.status).toBe(200);
	});
});
