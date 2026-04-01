// E2E — Descope auth mode: real JWT validation, test users via management SDK.
//
// Also exercises the full OIDC CI auth flow:
//   create trust policy via tRPC (using the test user's admin key)
//   → sign a JWT against a mock JWKS server
//   → exchange via POST /api/oauth/token
//   → pulumi login --oidc-token
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
//   PROCELLA_E2E_DESCOPE_TENANT_ID   — Descope tenant ID for the test user
//                                      (defaults to project ID)
//
// Auto-skipped when required env vars are absent.
// Runs on port :18081 (separate from dev-mode e2e on :18080).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import DescopeClient from "@descope/node-sdk";
import type { Subprocess } from "bun";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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

// Dedicated port — avoids conflict with dev-mode e2e suite on :18080
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
	await sdk.management.user.createTestUser(TEST_LOGIN_ID, {
		email: TEST_LOGIN_ID,
		verifiedEmail: true,
		displayName: "Procella E2E Test User",
		userTenants: [{ tenantId, roleNames: ["admin"] }],
	});

	const expireTime = Math.floor(Date.now() / 1000) + 600; // 10 min
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
			PROCELLA_OIDC_ENABLED: "true",
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
// OIDC mock JWKS server
// ============================================================================

interface MockIssuer {
	url: string;
	server: ReturnType<typeof Bun.serve>;
	privateKey: CryptoKey;
	stop(): void;
}

async function startMockIssuer(): Promise<MockIssuer> {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const publicJwk = await exportJWK(publicKey);
	publicJwk.kid = "e2e-key-1";
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";

	const server = Bun.serve({
		port: 0, // OS-assigned random port
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/.well-known/openid-configuration") {
				return Response.json({
					issuer: `http://localhost:${server.port}`,
					jwks_uri: `http://localhost:${server.port}/.well-known/jwks.json`,
				});
			}
			if (url.pathname === "/.well-known/jwks.json" || url.pathname === "/.well-known/jwks") {
				return Response.json({ keys: [publicJwk] });
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	return {
		url: `http://localhost:${server.port}`,
		server,
		privateKey,
		stop: () => server.stop(),
	};
}

async function signOidcJwt(
	issuer: MockIssuer,
	audience: string,
	claims: Record<string, unknown>,
): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "e2e-key-1" })
		.setIssuedAt()
		.setExpirationTime("5m")
		.setIssuer(issuer.url)
		.setAudience(audience)
		.setSubject(`repo:acme/infra:ref:refs/heads/main`)
		.sign(issuer.privateKey);
}

// ============================================================================
// tRPC helper (uses access key auth)
// ============================================================================

async function trpcMutation(procedure: string, input: unknown, token: string): Promise<unknown> {
	const body = JSON.stringify({ "0": { json: input } });
	const res = await fetch(`${DESCOPE_BACKEND_URL}/trpc/${procedure}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			// Access keys work on the token scheme, not Bearer
			Authorization: `token ${token}`,
		},
		body,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`tRPC ${procedure} failed (${res.status}): ${text}`);
	}
	const json = (await res.json()) as { result?: { data?: { json?: unknown } } }[];
	return json[0]?.result?.data?.json;
}

// ============================================================================
// Tests
// ============================================================================

describe_descope("Descope auth mode", () => {
	let server: Subprocess;
	let sdk: ReturnType<typeof DescopeClient>;
	let accessKey: string;
	let pulumiHome: string;
	let mockIssuer: MockIssuer;
	// orgSlug derived from tenantId — used as the `urn:pulumi:org:<slug>` audience
	let orgSlug: string;

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

		// Create test user + admin access key
		accessKey = await setupTestUser(sdk, tenantId);

		// Start Procella in Descope + OIDC mode
		server = await startDescopeServer();
		pulumiHome = await createPulumiHome();

		// Start mock OIDC issuer (in-process Bun.serve, random port)
		mockIssuer = await startMockIssuer();

		// Derive orgSlug — Procella resolves urn:pulumi:org:<slug> against the
		// caller's orgSlug claim. In Descope mode this comes from the tenant name.
		// Use a fixed slug matching the test tenant; fall back to tenantId itself.
		orgSlug = process.env.PROCELLA_E2E_ORG_SLUG ?? tenantId;

		// Register a trust policy via tRPC using the admin access key.
		// This teaches Procella to accept JWTs from our mock issuer.
		await trpcMutation(
			"oidc.createPolicy",
			{
				provider: "github-actions",
				displayName: "E2E Mock OIDC Issuer",
				issuer: mockIssuer.url,
				maxExpiration: 600,
				claimConditions: {
					// Lock to our test "org" by a stable claim
					repository_owner_id: "e2e-owner-123",
				},
				grantedRole: "member",
			},
			accessKey,
		);
	});

	afterAll(async () => {
		mockIssuer?.stop();
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

	// --- Pulumi CLI (Descope access key) ---

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

	// --- OIDC CI auth flow ---

	test("OIDC token exchange returns a Descope-backed access token", async () => {
		const audience = `urn:pulumi:org:${orgSlug}`;
		const jwt = await signOidcJwt(mockIssuer, audience, {
			repository_owner_id: "e2e-owner-123",
			repository: "acme/infra",
			actor: "e2e-bot",
		});

		const body = new URLSearchParams({
			audience,
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: jwt,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
			requested_token_type: "urn:pulumi:token-type:access_token:organization",
			expiration: "300",
		});

		const res = await fetch(`${DESCOPE_BACKEND_URL}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			access_token: string;
			issued_token_type: string;
			token_type: string;
			expires_in: number;
		};
		expect(data.access_token).toBeString();
		expect(data.access_token.length).toBeGreaterThan(10);
		expect(data.issued_token_type).toBe("urn:pulumi:token-type:access_token:organization");
		expect(data.expires_in).toBeLessThanOrEqual(300);
	});

	test("pulumi login --oidc-token succeeds with mock JWKS issuer", async () => {
		const audience = `urn:pulumi:org:${orgSlug}`;
		const jwt = await signOidcJwt(mockIssuer, audience, {
			repository_owner_id: "e2e-owner-123",
			repository: "acme/infra",
			actor: "e2e-bot",
		});

		const result = await pulumi(
			["login", "--oidc-token", jwt, "--oidc-org", orgSlug, DESCOPE_BACKEND_URL],
			{ pulumiHome },
		);
		expect(result.exitCode).toBe(0);
	});

	test("OIDC exchange is rejected when claim conditions do not match", async () => {
		const audience = `urn:pulumi:org:${orgSlug}`;
		// Wrong repository_owner_id — policy requires "e2e-owner-123"
		const jwt = await signOidcJwt(mockIssuer, audience, {
			repository_owner_id: "wrong-owner-000",
			repository: "other/repo",
		});

		const body = new URLSearchParams({
			audience,
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: jwt,
			subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
			requested_token_type: "urn:pulumi:token-type:access_token:organization",
		});

		const res = await fetch(`${DESCOPE_BACKEND_URL}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		expect(res.status).toBe(403);
		const data = (await res.json()) as { error: string };
		expect(data.error).toBe("access_denied");
	});
});
