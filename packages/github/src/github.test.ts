import { describe, expect, mock, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import {
	buildCommitStatusContext,
	buildGitHubAppConfig,
	buildPRCommentBody,
	createGitHubSetupStateService,
	type GitHubInstallationInfo,
	GitHubSetupError,
	githubRetryDelaySeconds,
	mapUpdateStatusToCommitState,
	OctokitGitHubDeliveryService,
	OctokitGitHubService,
	sanitizeDeliveryError,
	verifyGitHubWebhookSignature,
} from "./index.js";

const TEST_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
	modulusLength: 2048,
})
	.privateKey.export({ format: "pem", type: "pkcs1" })
	.toString();

function githubJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("@procella/github", () => {
	describe("verifyGitHubWebhookSignature", () => {
		test("returns true for valid signature", async () => {
			const payload = JSON.stringify({ hello: "world" });
			const secret = "webhook-secret";
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
			const hex = Array.from(new Uint8Array(sig))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			const ok = await verifyGitHubWebhookSignature(
				new TextEncoder().encode(payload),
				`sha256=${hex}`,
				secret,
			);
			expect(ok).toBe(true);
		});

		test("returns false for tampered signature", async () => {
			const payload = JSON.stringify({ hello: "world" });
			const ok = await verifyGitHubWebhookSignature(
				new TextEncoder().encode(payload),
				"sha256=deadbeef",
				"webhook-secret",
			);
			expect(ok).toBe(false);
		});

		test("returns false for empty signature", async () => {
			const payload = JSON.stringify({ hello: "world" });
			const ok = await verifyGitHubWebhookSignature(
				new TextEncoder().encode(payload),
				"",
				"webhook-secret",
			);
			expect(ok).toBe(false);
		});
	});

	describe("buildPRCommentBody", () => {
		test("builds markdown body with table and details link", () => {
			const body = buildPRCommentBody({
				updateId: "11111111-1111-4111-8111-111111111111",
				org: "acme",
				project: "infra",
				stack: "dev",
				kind: "preview",
				status: "succeeded",
				resourceChanges: { create: 3, update: 1, delete: 0, same: 4 },
				permalink: "https://example.com/update/1",
			});
			expect(body).toContain("**Changes:** create 3, delete 0, same 4, update 1");
			expect(body).toContain("<!-- procella:update:11111111-1111-4111-8111-111111111111 -->");
			expect(body).toContain("## Pulumi Preview");
			expect(body).toContain("**Stack:** `acme/infra/dev`");
			expect(body).toContain("[View details](https://example.com/update/1)");
		});

		test("renders unavailable when no terminal summary was captured", () => {
			const body = buildPRCommentBody({
				updateId: "22222222-2222-4222-8222-222222222222",
				org: "acme",
				project: "infra",
				stack: "dev",
				kind: "preview",
				status: "failed",
			});

			expect(body).toContain("**Summary:** unavailable");
			expect(body).not.toContain("**Changes:**");
		});
	});

	describe("mapUpdateStatusToCommitState", () => {
		test("maps Procella update statuses to GitHub commit states", () => {
			expect(mapUpdateStatusToCommitState("succeeded")).toBe("success");
			expect(mapUpdateStatusToCommitState("failed")).toBe("failure");
			expect(mapUpdateStatusToCommitState("cancelled")).toBe("failure");
			expect(mapUpdateStatusToCommitState("running")).toBe("pending");
			expect(mapUpdateStatusToCommitState("requested")).toBe("pending");
			expect(mapUpdateStatusToCommitState("not started")).toBe("pending");
			expect(mapUpdateStatusToCommitState("unknown")).toBe("error");
		});
	});

	describe("buildCommitStatusContext", () => {
		test("is stable, stack-specific, and within GitHub's limit", () => {
			const target = { org: "acme", project: "infra", stack: "production" };
			expect(buildCommitStatusContext(target)).toBe("procella/acme/infra/production");
			const long = buildCommitStatusContext({
				org: "o".repeat(64),
				project: "p".repeat(64),
				stack: "s".repeat(64),
			});
			expect(long).toHaveLength(100);
			expect(long).toBe(
				buildCommitStatusContext({
					org: "o".repeat(64),
					project: "p".repeat(64),
					stack: "s".repeat(64),
				}),
			);
		});
	});
	describe("githubRetryDelaySeconds", () => {
		test("backs off exponentially with a fifteen-minute ceiling", () => {
			expect(githubRetryDelaySeconds(1)).toBe(5);
			expect(githubRetryDelaySeconds(4)).toBe(40);
			expect(githubRetryDelaySeconds(100)).toBe(900);
		});
	});

	describe("sanitizeDeliveryError", () => {
		test("redacts credentials and bounds persisted errors", () => {
			const error = new Error(
				`Authorization: Bearer top-secret https://user:pass@example.com/${"x".repeat(600)}`,
			);
			const sanitized = sanitizeDeliveryError(error);
			expect(sanitized).not.toContain("top-secret");
			expect(sanitized).not.toContain("user:pass");
			expect(sanitized.length).toBeLessThanOrEqual(500);
		});
	});
});

const testConfig = {
	appId: "123",
	clientId: "Iv1.test-client-id",
	clientSecret: "oauth-client-secret",
	privateKey: TEST_GITHUB_APP_PRIVATE_KEY,
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
};

const BROWSER_NONCE = "a".repeat(43);
const OTHER_BROWSER_NONCE = "b".repeat(43);
const BROWSER_BINDING = createHash("sha256").update(BROWSER_NONCE).digest("hex");
const INSTALL_STATE_INPUT = {
	tenantId: "tenant-a",
	accountLogin: "acme",
	initiatorUserId: "user-a",
	browserBinding: BROWSER_BINDING,
	phase: "install",
} as const;
const AUTHORIZATION_STATE_INPUT = {
	...INSTALL_STATE_INPUT,
	phase: "authorize",
	installationId: 101,
} as const;

function mockInstallationRequest() {
	return mock(async () => ({
		data: {
			id: 101,
			app_id: 123,
			account: { login: "acme" },
			target_type: "Organization",
			repository_selection: "all",
		},
	}));
}
describe("GitHub setup state", () => {
	test("issues one-time installation state bound to the tenant admin and browser", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const values = mock(async () => []);
		const request = mock(async () => ({ data: { id: 123, slug: "procella" } }));
		const service = new OctokitGitHubService({
			db: {
				delete: mock(() => ({ where: mock(async () => []) })),
				insert: mock(() => ({ values })),
			} as unknown as Database,
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			setupStates,
		});

		const url = new URL(
			await service.issueInstallationUrl("tenant-a", "acme", "user-a", BROWSER_NONCE),
		);
		expect(url.origin + url.pathname).toBe("https://github.com/apps/procella/installations/new");
		const claims = await setupStates.verify(url.searchParams.get("state") ?? "");
		expect(claims).toMatchObject(INSTALL_STATE_INPUT);
		expect(values).toHaveBeenCalledWith({
			jti: claims.jti,
			tenantId: "tenant-a",
			expiresAt: claims.expiresAt,
		});
		expect(request).toHaveBeenCalledWith("GET /app");
	});

	test("disables the GitHub service when App credentials are absent", () => {
		expect(
			buildGitHubAppConfig({ ticketSigningKey: "state-signing-key-state-signing-key" } as Config),
		).toBeNull();
	});

	test("builds App configuration with OAuth credentials", () => {
		const config = buildGitHubAppConfig({
			githubAppId: "123",
			githubAppClientId: "Iv1.test-client-id",
			githubAppClientSecret: "oauth-client-secret",
			githubAppPrivateKey: TEST_GITHUB_APP_PRIVATE_KEY,
			githubAppWebhookSecret: "webhook-secret",
			ticketSigningKey: "state-signing-key-state-signing-key",
		} as Config);
		expect(config).toEqual(testConfig);
	});

	test("rejects tampered state", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		const [header, payload, signature] = state.split(".");
		const tamperedSignature = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1)}`;
		const tampered = `${header}.${payload}.${tamperedSignature}`;
		await expect(setupStates.verify(tampered)).rejects.toMatchObject({ code: "invalid_state" });
	});

	test("rejects expired state", async () => {
		let now = new Date("2026-01-01T00:00:00Z");
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey, {
			now: () => now,
			ttlSeconds: 60,
		});
		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		now = new Date("2026-01-01T00:01:01Z");
		await expect(setupStates.verify(state)).rejects.toMatchObject({ code: "expired_state" });
	});
});

describe("OctokitGitHubService user authorization", () => {
	test("installs before checking organization administration with the installation id", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const installationReturning = mock(async () => [installationRow]);
		const onConflictDoUpdate = mock(() => ({ returning: installationReturning }));
		const stateValues = mock(async (_value?: unknown) => []);
		const values = mock((value: Record<string, unknown>) =>
			"installationId" in value ? { onConflictDoUpdate } : stateValues(value),
		);
		const tx = {
			delete: mock(() => ({
				where: mock(() => ({ returning: mock(async () => [{ jti: "setup-state" }]) })),
			})),
			insert: mock(() => ({ values })),
		} as unknown as Database;
		const transaction = mock(async (callback: (database: Database) => Promise<unknown>) =>
			callback(tx),
		);
		const events: string[] = [];
		let installed = false;
		const appRequest = mock(async (route: string) => {
			if (route === "GET /app") return { data: { id: 123, slug: "procella" } };
			events.push("installation");
			return {
				data: {
					id: 101,
					app_id: 123,
					account: { login: "acme" },
					target_type: "Organization",
					repository_selection: "all",
				},
			};
		});
		const oauthFetch = mock(async (input: string | URL | Request) => {
			if (String(input).includes("login/oauth/access_token")) {
				events.push("exchange");
				return new Response(JSON.stringify({ access_token: "user-token", token_type: "bearer" }));
			}
			events.push("revoke");
			return new Response(null, { status: 204 });
		});
		const userRequest = mock(async (route: string) => {
			if (!installed) throw Object.assign(new Error("App is not installed"), { status: 403 });
			if (route === "GET /user/installations") {
				events.push("user-installations");
				return { data: { total_count: 1, installations: [{ id: 101 }] } };
			}
			if (route === "GET /user") {
				events.push("user");
				return { data: { login: "alice" } };
			}
			events.push("membership");
			return { data: { state: "active", role: "admin" } };
		});
		const service = new OctokitGitHubService({
			db: {
				delete: mock(() => ({ where: mock(async () => []) })),
				insert: mock(() => ({ values: stateValues })),
				transaction,
			} as unknown as Database,
			config: testConfig,
			appClient: { request: appRequest } as unknown as Octokit,
			setupStates,
			userClientFactory: () => ({ request: userRequest }) as unknown as Octokit,
			oauthFetch: oauthFetch as unknown as typeof fetch,
		});

		const installationUrl = new URL(
			await service.issueInstallationUrl("tenant-a", "acme", "user-a", BROWSER_NONCE),
		);
		const installationState = installationUrl.searchParams.get("state") ?? "";
		installed = true; // GitHub redirects to /github/setup only after installing the App.
		const authorizationUrl = new URL(
			await service.completeInstallation(installationState, 101, BROWSER_NONCE),
		);
		const authorizationState = authorizationUrl.searchParams.get("state") ?? "";
		expect(await setupStates.verify(authorizationState)).toMatchObject(AUTHORIZATION_STATE_INPUT);
		await expect(
			service.completeAuthorization(authorizationState, "oauth-code", BROWSER_NONCE),
		).resolves.toEqual(installationRow);
		expect(events).toEqual([
			"installation",
			"installation",
			"exchange",
			"user-installations",
			"user",
			"membership",
			"revoke",
		]);
		expect(userRequest).toHaveBeenCalledWith(
			"GET /user/installations",
			expect.objectContaining({ page: 1, per_page: 100 }),
		);
	});

	test("rejects tenant A callback state from tenant B browser before external calls", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const appRequest = mock(() => {
			throw new Error("must not load installation");
		});
		const transaction = mock(() => {
			throw new Error("must not consume state");
		});
		const oauthFetch = mock(() => {
			throw new Error("must not exchange code");
		});
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: { request: appRequest } as unknown as Octokit,
			setupStates,
			oauthFetch: oauthFetch as unknown as typeof fetch,
		});
		const installationState = await setupStates.issue(INSTALL_STATE_INPUT);
		const authorizationState = await setupStates.issue(AUTHORIZATION_STATE_INPUT);

		await expect(
			service.completeInstallation(installationState.state, 101, OTHER_BROWSER_NONCE),
		).rejects.toMatchObject({ code: "invalid_state" });
		await expect(
			service.completeAuthorization(authorizationState.state, "oauth-code", OTHER_BROWSER_NONCE),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(appRequest).not.toHaveBeenCalled();
		expect(oauthFetch).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	test("rejects non-admin GitHub users without consuming authorization state", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(AUTHORIZATION_STATE_INPUT);
		const transaction = mock(() => {
			throw new Error("must not consume or insert state");
		});
		const oauthFetch = mock(async (input: string | URL | Request) =>
			String(input).includes("login/oauth/access_token")
				? new Response(JSON.stringify({ access_token: "user-token", token_type: "bearer" }))
				: new Response(null, { status: 503 }),
		);
		const userRequest = mock(async (route: string) => {
			if (route === "GET /user/installations") {
				return { data: { total_count: 1, installations: [{ id: 101 }] } };
			}
			if (route === "GET /user") return { data: { login: "alice" } };
			return { data: { state: "active", role: "member" } };
		});
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			userClientFactory: () => ({ request: userRequest }) as unknown as Octokit,
			oauthFetch: oauthFetch as unknown as typeof fetch,
		});

		await expect(
			service.completeAuthorization(state, "oauth-code", BROWSER_NONCE),
		).rejects.toMatchObject({ code: "unauthorized_account" });
		expect(transaction).not.toHaveBeenCalled();
		expect(oauthFetch).toHaveBeenCalledTimes(2);
	});

	test("reports installed-account request failures separately from denied membership", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(AUTHORIZATION_STATE_INPUT);
		const transaction = mock(() => {
			throw new Error("must not consume or insert state");
		});
		const oauthFetch = mock(async (input: string | URL | Request) =>
			String(input).includes("login/oauth/access_token")
				? new Response(JSON.stringify({ access_token: "user-token", token_type: "bearer" }))
				: new Response(null, { status: 204 }),
		);
		const userRequest = mock(async () => {
			throw Object.assign(new Error("GitHub unavailable"), { status: 503 });
		});
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			userClientFactory: () => ({ request: userRequest }) as unknown as Octokit,
			oauthFetch: oauthFetch as unknown as typeof fetch,
		});

		await expect(
			service.completeAuthorization(state, "oauth-code", BROWSER_NONCE),
		).rejects.toMatchObject({ code: "authorization_failed" });
		expect(transaction).not.toHaveBeenCalled();
		expect(oauthFetch).toHaveBeenCalledTimes(2);
	});
});

const installationRow = {
	id: "row-1",
	tenantId: "tenant-a",
	installationId: 101,
	accountLogin: "acme",
	accountType: "Organization",
	repositorySelection: "all",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
} satisfies GitHubInstallationInfo;

function readOnlyDb(rows: GitHubInstallationInfo[]): Database {
	const chain = {
		where: mock(() => chain),
		orderBy: mock(async () => rows),
		limit: mock(async () => rows.slice(0, 1)),
	};
	return { select: mock(() => ({ from: mock(() => chain) })) } as unknown as Database;
}

describe("OctokitGitHubService installation binding", () => {
	test("loads authoritative installation data before rotating to authorization state", async () => {
		const stateValues = mock(async () => []);
		const consumedReturning = mock(async () => [{ jti: "state-id" }]);
		const tx = {
			delete: mock(() => ({
				where: mock(() => ({ returning: consumedReturning })),
			})),
			insert: mock(() => ({ values: stateValues })),
		} as unknown as Database;
		const db = {
			transaction: mock(async (callback: (transaction: Database) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as Database;
		const request = mockInstallationRequest();
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db,
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		const authorizationUrl = new URL(await service.completeInstallation(state, 101, BROWSER_NONCE));
		const claims = await setupStates.verify(authorizationUrl.searchParams.get("state") ?? "");
		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(claims).toMatchObject(AUTHORIZATION_STATE_INPUT);
		expect(request).toHaveBeenCalledWith("GET /app/installations/{installation_id}", {
			installation_id: 101,
		});
		expect(stateValues).toHaveBeenCalledWith({
			jti: claims.jti,
			tenantId: "tenant-a",
			expiresAt: claims.expiresAt,
		});
	});

	test("rejects signed state for a tenant that does not match the stored initiator", async () => {
		const insert = mock(() => {
			throw new Error("must not persist");
		});
		const tx = {
			delete: mock(() => ({
				where: mock(() => ({ returning: mock(async () => []) })),
			})),
			insert,
		} as unknown as Database;
		const db = {
			transaction: mock(async (callback: (transaction: Database) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as Database;
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({
					data: {
						id: 101,
						app_id: 123,
						account: { login: "acme" },
						target_type: "Organization",
						repository_selection: "all",
					},
				})),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue({ ...INSTALL_STATE_INPUT, tenantId: "tenant-b" });
		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).rejects.toMatchObject({
			code: "replayed_state",
		});
		expect(insert).not.toHaveBeenCalled();
	});

	test("rejects a forged installation id that GitHub does not recognize", async () => {
		const transaction = mock(() => {
			throw new Error("must not persist");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => {
					throw Object.assign(new Error("Not Found"), { status: 404 });
				}),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		await expect(service.completeInstallation(state, 999, BROWSER_NONCE)).rejects.toBeInstanceOf(
			GitHubSetupError,
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	test("rejects installation data for a different GitHub App", async () => {
		const transaction = mock(() => {
			throw new Error("must not persist");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => ({
					data: {
						id: 999,
						app_id: 999,
						account: { login: "attacker" },
						target_type: "Organization",
						repository_selection: "all",
					},
				})),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		await expect(service.completeInstallation(state, 999, BROWSER_NONCE)).rejects.toMatchObject({
			code: "invalid_installation",
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	test("rejects an installation for an unauthorized account without consuming state", async () => {
		const transaction = mock(() => {
			throw new Error("must not consume state or insert installation");
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: {
				request: mock(async () => ({
					data: {
						id: 101,
						app_id: 123,
						account: { login: "other-org" },
						target_type: "Organization",
						repository_selection: "all",
					},
				})),
			} as unknown as Octokit,
			setupStates,
		});

		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).rejects.toMatchObject({
			code: "unauthorized_account",
		});
		expect(transaction).not.toHaveBeenCalled();
	});

	test("unknown webhook installations cannot invent a tenant binding", async () => {
		const insert = mock(() => {
			throw new Error("must not insert");
		});
		const update = mock(() => {
			throw new Error("must not update");
		});
		const service = new OctokitGitHubService({
			db: Object.assign(readOnlyDb([]), { insert, update }),
			config: testConfig,
			appClient: {} as Octokit,
		});

		await service.handleWebhookEvent("installation", {
			action: "created",
			installation: {
				id: 777,
				account: { login: "forged-tenant", type: "Organization" },
				repository_selection: "all",
			},
		});
		expect(insert).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
});

describe("OctokitGitHubService repository resolution", () => {
	test("resolves a renamed account from the authoritative installation id", async () => {
		const request = mock(async () => ({ data: { id: 101 } }));
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({
				tenantId: "tenant-a",
				owner: "renamed-acme",
				repo: "infra",
			}),
		).toEqual(installationRow);
		expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/installation", {
			owner: "renamed-acme",
			repo: "infra",
			request: { signal: expect.anything() },
		});
	});

	test("rejects a public repository that is not selected for the installation", async () => {
		const selected: GitHubInstallationInfo = {
			...installationRow,
			repositorySelection: "selected",
		};
		const reposGet = mock(async () => ({ data: { id: 1, visibility: "public" } }));
		const request = mock(async () => {
			throw Object.assign(new Error("Not Found"), { status: 404 });
		});
		const service = new OctokitGitHubService({
			db: readOnlyDb([selected]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			installationClientFactory: () =>
				({ rest: { repos: { get: reposGet } } }) as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "public" }),
		).toBeNull();
		expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/installation", {
			owner: "acme",
			repo: "public",
			request: { signal: expect.anything() },
		});
		expect(reposGet).not.toHaveBeenCalled();
	});

	test("rejects an authoritative installation that is not bound to the tenant", async () => {
		const request = mock(async () => ({ data: { id: 999 } }));
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "infra" }),
		).toBeNull();
	});

	test("selects the tenant-bound installation returned by the app-JWT lookup", async () => {
		const denied = { ...installationRow, id: "row-2", installationId: 102 };
		const allowed = { ...installationRow, id: "row-3", installationId: 103 };
		const request = mock(async () => ({ data: { id: 103 } }));
		const service = new OctokitGitHubService({
			db: readOnlyDb([denied, allowed]),
			config: testConfig,
			appClient: { request } as unknown as Octokit,
		});

		expect(
			await service.resolveInstallation({ tenantId: "tenant-a", owner: "acme", repo: "infra" }),
		).toEqual(allowed);
	});
	test("normalizes a real Octokit repository timeout and succeeds on retry", async () => {
		let now = 0;
		let attempts = 0;
		const originalNow = Date.now;
		const customFetch = mock(async () => {
			attempts += 1;
			if (attempts === 1) {
				now = 100;
				throw new DOMException("timed out", "TimeoutError");
			}
			return githubJsonResponse({ id: 101 });
		});
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([installationRow]),
			config: { appId: "123", privateKey: "unused" },
			appClient: new Octokit({ request: { fetch: customFetch as unknown as typeof fetch } }),
		});
		const target = { tenantId: "tenant-a", owner: "acme", repo: "infra" };

		Date.now = () => now;
		try {
			await expect(service.resolveInstallation(target, { deadlineMs: 100 })).rejects.toThrow(
				"deadline exceeded",
			);
			now = 0;
			await expect(service.resolveInstallation(target, { deadlineMs: 10_000 })).resolves.toEqual(
				installationRow,
			);
			expect(attempts).toBe(2);
		} finally {
			Date.now = originalNow;
		}
	});

	test("keeps a real Octokit request-cap timeout retryable with ample delivery budget", async () => {
		const originalNow = Date.now;
		const customFetch = mock(async () => {
			throw new DOMException("timed out", "TimeoutError");
		});
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([installationRow]),
			config: { appId: "123", privateKey: "unused" },
			appClient: new Octokit({ request: { fetch: customFetch as unknown as typeof fetch } }),
		});

		Date.now = () => 0;
		try {
			await expect(
				service.resolveInstallation(
					{ tenantId: "tenant-a", owner: "acme", repo: "infra" },
					{ deadlineMs: 40_000 },
				),
			).rejects.toMatchObject({ name: "HttpError", status: 500 });
		} finally {
			Date.now = originalNow;
		}
	});
	test("propagates an ordinary GitHub 500 before the deadline", async () => {
		const customFetch = mock(async () =>
			githubJsonResponse({ message: "Internal Server Error" }, 500),
		);
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([installationRow]),
			config: { appId: "123", privateKey: "unused" },
			appClient: new Octokit({ request: { fetch: customFetch as unknown as typeof fetch } }),
		});

		await expect(
			service.resolveInstallation(
				{ tenantId: "tenant-a", owner: "acme", repo: "infra" },
				{ deadlineMs: Date.now() + 10_000 },
			),
		).rejects.toMatchObject({ status: 500 });
	});
});

describe("OctokitGitHubDeliveryService comments", () => {
	test("creates, finds, and edits one marked PR comment", async () => {
		const createComment = mock(async () => ({ data: { id: 123 } }));
		const updateComment = mock(async () => ({ data: { id: 123 } }));
		const listComments = mock(async () => ({
			data: [
				{ id: 122, body: "unrelated" },
				{ id: 123, body: "<!-- procella:update:update-1 -->\nresult" },
			],
		}));
		const createCommitStatus = mock(async () => ({}));
		const installationClient = {
			rest: {
				issues: { createComment, listComments, updateComment },
				repos: { createCommitStatus },
			},
		} as unknown as Octokit;
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([]),
			config: { appId: "123", privateKey: "unused" },
			appClient: {} as Octokit,
			installationClientFactory: () => installationClient,
		});

		expect(await service.createPRComment(101, "acme", "infra", 42, "pending")).toBe(123);
		expect(
			await service.findPRComment(101, "acme", "infra", 42, "<!-- procella:update:update-1 -->"),
		).toBe(123);
		await service.updatePRComment(101, "acme", "infra", 123, "complete");
		await service.setCommitStatus(101, "acme", "infra", "abc123", "success", "done", "ctx");
		expect(await service.findPRComment(101, "acme", "infra", 42, "missing-marker")).toBeNull();

		expect(createComment).toHaveBeenCalledTimes(1);
		expect(listComments).toHaveBeenCalledWith({
			owner: "acme",
			repo: "infra",
			issue_number: 42,
			per_page: 100,
			page: 1,
			request: { signal: expect.anything() },
		});
		expect(updateComment).toHaveBeenCalledWith({
			owner: "acme",
			repo: "infra",
			comment_id: 123,
			body: "complete",
			request: { signal: expect.anything() },
		});
		expect(createCommitStatus).toHaveBeenCalledWith({
			owner: "acme",
			repo: "infra",
			sha: "abc123",
			state: "success",
			description: "done",
			context: "ctx",
			request: { signal: expect.anything() },
		});
	});

	test("checks the deadline before fetching another comment page", async () => {
		let now = 0;
		const originalNow = Date.now;
		Date.now = () => now;
		const listComments = mock(async () => {
			now = 20;
			return { data: Array.from({ length: 100 }, (_, id) => ({ id, body: "unrelated" })) };
		});
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([]),
			config: { appId: "123", privateKey: "unused" },
			appClient: {} as Octokit,
			installationClientFactory: () =>
				({ rest: { issues: { listComments } } }) as unknown as Octokit,
		});

		try {
			await expect(
				service.findPRComment(101, "acme", "infra", 42, "missing", { deadlineMs: 10 }),
			).rejects.toThrow("deadline exceeded");
			expect(listComments).toHaveBeenCalledTimes(1);
		} finally {
			Date.now = originalNow;
		}
	});

	test("normalizes a real Octokit paginated abort and succeeds later", async () => {
		let now = 0;
		let calls = 0;
		const originalNow = Date.now;
		const customFetch = mock(async () => {
			calls += 1;
			if (calls === 1) {
				return githubJsonResponse(
					Array.from({ length: 100 }, (_, id) => ({ id, body: "unrelated" })),
				);
			}
			if (calls === 2) {
				now = 100;
				throw new DOMException("aborted", "AbortError");
			}
			return githubJsonResponse([{ id: 123, body: "<!-- procella:update:update-1 -->" }]);
		});
		const installationClient = new Octokit({
			request: { fetch: customFetch as unknown as typeof fetch },
		});
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([]),
			config: { appId: "123", privateKey: "unused" },
			appClient: {} as Octokit,
			installationClientFactory: () => installationClient,
		});

		Date.now = () => now;
		try {
			await expect(
				service.findPRComment(101, "acme", "infra", 42, "missing", { deadlineMs: 100 }),
			).rejects.toThrow("deadline exceeded");
			now = 0;
			await expect(
				service.findPRComment(101, "acme", "infra", 42, "<!-- procella:update:update-1 -->", {
					deadlineMs: 10_000,
				}),
			).resolves.toBe(123);
			expect(calls).toBe(3);
		} finally {
			Date.now = originalNow;
		}
	});
	test("rejects an unsafe comment identifier", async () => {
		const service = new OctokitGitHubDeliveryService({
			db: readOnlyDb([]),
			config: { appId: "123", privateKey: "unused" },
			appClient: {} as Octokit,
			installationClientFactory: () =>
				({
					rest: {
						issues: { createComment: mock(async () => ({ data: { id: Number.MAX_VALUE } })) },
					},
				}) as unknown as Octokit,
		});

		await expect(service.createPRComment(101, "acme", "infra", 42, "body")).rejects.toThrow(
			"invalid comment ID",
		);
	});
});
