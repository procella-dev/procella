// Regression coverage for M3 — POST /api/auth/cli-token mints long-lived
// Descope access keys, so only interactive user sessions may call it. Machine
// credentials (access keys, workload OIDC identities) must be rejected on BOTH
// route assemblies, which register the handler independently.

import { beforeAll, describe, expect, test } from "bun:test";
import { PostgresNotificationHub } from "@procella/api/src/notifications.js";
import type { AuditService } from "@procella/audit";
import { type AuthConfig, type AuthService, DescopeAuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import type { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import type { Env } from "../types.js";
import { createApp } from "./index.js";
import { createWebApp } from "./web.js";

const authConfig: AuthConfig = {
	mode: "dev",
	token: "session-token",
	userLogin: "alice",
	orgLogin: "my-org",
};

const sessionCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};

const accessKeyCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "token:K2accesskey",
	login: "ci-access-key",
	roles: ["admin"],
	principalType: "token",
};

const workloadCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "",
	login: "github-actions:acme/procella",
	roles: ["admin"],
	principalType: "workload",
	workload: {
		provider: "github",
		issuer: "https://token.actions.githubusercontent.com",
		subject: "repo:acme/procella:ref:refs/heads/main",
		repository: "acme/procella",
	},
};

const callersByToken: Record<string, Caller> = {
	"session-token": sessionCaller,
	"access-key-token": accessKeyCaller,
	"workload-token": workloadCaller,
};

function mockAuthService(
	mintedKeyNames: string[],
	authenticatedHeaders: string[] = [],
): AuthService {
	return {
		authenticate: async (request: Request) => {
			const header = request.headers.get("Authorization") ?? "";
			authenticatedHeaders.push(header);
			const caller = callersByToken[header.replace(/^token /, "")];
			if (!caller) {
				throw new UnauthorizedError("Invalid token");
			}
			return caller;
		},
		authenticateUpdateToken: async () => ({ updateId: "upd-1", stackId: "stack-1" }),
		resolveUserDisplayName: async () => null,
		createCliAccessKey: async (_caller: Caller, name: string) => {
			mintedKeyNames.push(name);
			return `cli-access-key:${name}`;
		},
	};
}

function makeApiApp(
	mintedKeyNames: string[],
	auth: AuthService = mockAuthService(mintedKeyNames),
): Hono<Env> {
	return createApp({
		auth,
		authConfig,
		audit: {} as AuditService,
		db: {} as Database,
		notifications: new PostgresNotificationHub({
			connectionString: "postgres://test:test@localhost:5432/test",
		}),
		storage: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
			exists: async () => false,
		},
		stacks: {} as StacksService,
		updates: {} as UpdatesService,
		webhooks: {} as WebhooksService,
		esc: {} as EscService,
		github: null,
	});
}

function makeWebApp(
	mintedKeyNames: string[],
	auth: AuthService = mockAuthService(mintedKeyNames),
): Hono<Env> {
	return createWebApp({
		auth,
		authConfig,
		audit: {} as AuditService,
		db: {} as Database,
		notifications: new PostgresNotificationHub({
			connectionString: "postgres://test:test@localhost:5432/test",
		}),
		stacks: {} as StacksService,
		updates: {} as UpdatesService,
		webhooks: {} as WebhooksService,
		esc: {} as EscService,
		github: null,
	});
}

function cliTokenRequest(authorization: string): [string, RequestInit] {
	return [
		"/api/auth/cli-token",
		{
			method: "POST",
			headers: { Authorization: authorization, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "attacker-minted-key" }),
		},
	];
}

interface JwtHarness {
	issuer: string;
	projectId: string;
	privateKey: CryptoKey;
	jwks: JWTVerifyGetKey;
}

async function createJwtHarness(): Promise<JwtHarness> {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const publicJwk = await exportJWK(publicKey);
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	publicJwk.kid = "descope-route-test-key";

	return {
		issuer: "https://descope-route.test.local",
		projectId: "P3routeTest",
		privateKey,
		jwks: createLocalJWKSet({ keys: [publicJwk] }),
	};
}

let jwtHarness: JwtHarness;
beforeAll(async () => {
	jwtHarness = await createJwtHarness();
});

async function signJwt(claims: Record<string, unknown>): Promise<string> {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "descope-route-test-key" })
		.setIssuer(jwtHarness.issuer)
		.setAudience(jwtHarness.projectId)
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(jwtHarness.privateKey);
}

function descopeAuthService(mintedKeyNames: string[]): DescopeAuthService {
	const sdk = {
		management: {
			user: {
				loadByUserId: () => Promise.resolve({ ok: true, data: { email: "alice@example.com" } }),
			},
			accessKey: {
				create: (name: string) => {
					mintedKeyNames.push(name);
					return Promise.resolve({ ok: true, data: { cleartext: `cli-access-key:${name}` } });
				},
			},
		},
	} as never;

	return new DescopeAuthService({
		sdk,
		config: { projectId: jwtHarness.projectId, issuer: jwtHarness.issuer },
		jwks: jwtHarness.jwks,
	});
}

const jwtClaims = {
	dct: "t-1",
	tenant_name: "My Org",
	tenants: { "t-1": { roles: ["admin"] } },
};

const assemblies: Array<{
	name: string;
	make: (minted: string[], auth?: AuthService) => Hono<Env>;
}> = [
	{ name: "createApp", make: makeApiApp },
	{ name: "createWebApp", make: makeWebApp },
];

for (const assembly of assemblies) {
	describe(`POST /api/auth/cli-token principal restriction — ${assembly.name}`, () => {
		test("rejects access-key callers without minting a key", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token access-key-token"));

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "CLI tokens can only be created from an interactive user session",
			});
			expect(minted).toEqual([]);
		});

		test("rejects a raw legacy access-key JWT replayed as Bearer", async () => {
			const minted: string[] = [];
			const auth = descopeAuthService(minted);
			const exchangedJwt = await signJwt({
				...jwtClaims,
				sub: "K3-legacy-access-key",
				procellaLogin: "legacy-key",
			});
			const app = assembly.make(minted, auth);

			const res = await app.request(...cliTokenRequest(`Bearer ${exchangedJwt}`));
			auth.dispose();

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "CLI tokens can only be created from an interactive user session",
			});
			expect(minted).toEqual([]);
		});

		test("still mints for a documented interactive Bearer session", async () => {
			const minted: string[] = [];
			const auth = descopeAuthService(minted);
			const sessionJwt = await signJwt({
				...jwtClaims,
				sub: "user-1",
				procellaLogin: "alice",
				amr: ["pwd"],
			});
			const app = assembly.make(minted, auth);

			const res = await app.request(...cliTokenRequest(`Bearer ${sessionJwt}`));
			auth.dispose();

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ token: "cli-access-key:attacker-minted-key" });
			expect(minted).toEqual(["attacker-minted-key"]);
		});

		test("still mints for a documented interactive cookie session", async () => {
			const minted: string[] = [];
			const auth = descopeAuthService(minted);
			const sessionJwt = await signJwt({
				...jwtClaims,
				sub: "user-1",
				procellaLogin: "alice",
				amr: ["pwd"],
			});
			const app = assembly.make(minted, auth);

			const res = await app.request("/api/auth/cli-token", {
				method: "POST",
				headers: { Cookie: `DS=${sessionJwt}`, "Content-Type": "application/json" },
				body: JSON.stringify({ name: "attacker-minted-key" }),
			});
			auth.dispose();

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ token: "cli-access-key:attacker-minted-key" });
			expect(minted).toEqual(["attacker-minted-key"]);
		});

		test("rejects workload callers without minting a key", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token workload-token"));

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "CLI tokens can only be created from an interactive user session",
			});
			expect(minted).toEqual([]);
		});

		test("still mints for interactive session callers", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token session-token"));

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ token: "cli-access-key:attacker-minted-key" });
			expect(minted).toEqual(["attacker-minted-key"]);
		});

		test("rejects unauthenticated callers", async () => {
			const minted: string[] = [];
			const app = assembly.make(minted);

			const res = await app.request(...cliTokenRequest("token bogus-token"));

			expect(res.status).toBe(401);
			expect(minted).toEqual([]);
		});

		test("counts unauthorized attempts and rejects an exhausted request before auth, inflation, or minting", async () => {
			const minted: string[] = [];
			const authenticatedHeaders: string[] = [];
			const auth = mockAuthService(minted, authenticatedHeaders);
			const app = assembly.make(minted, auth);

			for (let attempt = 1; attempt <= 10; attempt++) {
				const res = await app.request(...cliTokenRequest("token bogus-token"));
				expect(res.status).toBe(401);
			}
			expect(authenticatedHeaders).toHaveLength(10);

			// If decompression runs, this malformed gzip body returns 400 instead of 429.
			const limited = await app.request("/api/auth/cli-token", {
				method: "POST",
				headers: {
					Authorization: "token session-token",
					"Content-Type": "application/json",
					"Content-Encoding": "gzip",
				},
				body: new Uint8Array([0x1f, 0x8b, 0x08]),
			});

			expect(limited.status).toBe(429);
			expect(await limited.json()).toEqual({ error: "Too many requests" });
			expect(authenticatedHeaders).toHaveLength(10);
			expect(minted).toEqual([]);
		});
	});
}
