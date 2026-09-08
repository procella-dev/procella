import { describe, expect, mock, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import { getTableName } from "drizzle-orm";
import {
	buildCommitStatusContext,
	buildGitHubAppConfig,
	buildPRCommentBody,
	createGitHubSetupStateService,
	type GitHubAccountCandidate,
	type GitHubInstallationInfo,
	GitHubOutboundError,
	type GitHubOutboundIdentityService,
	GitHubSetupError,
	type GitHubVisibleInstallation,
	githubRetryDelaySeconds,
	mapUpdateStatusToCommitState,
	OctokitGitHubDeliveryService,
	OctokitGitHubService,
	sanitizeDeliveryError,
	VaultedGitHubIdentityService,
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
	privateKey: TEST_GITHUB_APP_PRIVATE_KEY,
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
	outboundAppId: "procella-github",
};

const BROWSER_NONCE = "a".repeat(43);
const OTHER_BROWSER_NONCE = "b".repeat(43);
const BROWSER_BINDING = createHash("sha256").update(BROWSER_NONCE).digest("hex");
const CONNECT_STATE_INPUT = {
	tenantId: "tenant-a",
	initiatorUserId: "user-a",
	browserBinding: BROWSER_BINDING,
	phase: "connect",
} as const;
const INSTALL_STATE_INPUT = {
	...CONNECT_STATE_INPUT,
	accountLogin: "acme",
	phase: "install",
} as const;
const INITIATOR = { tenantId: "tenant-a", userId: "user-a" } as const;

/** Vaulted-identity stub that records the verification calls the flow makes. */
function stubOutbound(
	overrides: Partial<GitHubOutboundIdentityService> = {},
): GitHubOutboundIdentityService {
	return {
		loadIdentity: mock(async () => ({ login: "alice" })),
		loadPendingConnection: mock(async () => ({ tokenId: "tok-a", login: "alice" })),
		listAdministeredAccounts: mock(async () => [] as GitHubAccountCandidate[]),
		listVisibleInstallations: mock(async () => [] as GitHubVisibleInstallation[]),
		verifyAccountAdministration: mock(async () => undefined),
		verifyInstallationAccess: mock(async () => undefined),
		drainTenantTokens: mock(async () => ["tok-a"] as readonly string[]),
		...overrides,
	};
}

/**
 * Transaction-capable db double: state rows are consumed, confirmations and
 * installations upserted.
 */
function setupStateDb(
	options: {
		consumed?: boolean;
		installationRow?: unknown;
		/** Row `completeInstallation` reads under the lock. Defaults to "tok-a", matching `stubOutbound()`'s pending token. `null` simulates no confirmation. */
		confirmedTokenId?: string | null;
	} = {},
) {
	const stateValues = mock(async (_value?: unknown) => []);
	const installationReturning = mock(async () => [options.installationRow ?? installationRow]);
	const confirmationConflict = mock(async () => []);
	const values = mock((value: Record<string, unknown>) => {
		if ("installationId" in value) {
			return { onConflictDoUpdate: mock(() => ({ returning: installationReturning })) };
		}
		if ("tokenId" in value) return { onConflictDoUpdate: confirmationConflict };
		return stateValues(value);
	});
	const consumedReturning = mock(async () =>
		options.consumed === false ? [] : [{ jti: "state" }],
	);
	const execute = mock(async () => []);
	const confirmedTokenId =
		options.confirmedTokenId === undefined ? "tok-a" : options.confirmedTokenId;
	const confirmationRow = confirmedTokenId === null ? [] : [{ tokenId: confirmedTokenId }];
	const select = mock(() => ({
		from: mock(() => ({
			where: mock(() => ({ limit: mock(async () => confirmationRow) })),
		})),
	}));
	const tx = {
		delete: mock(() => ({ where: mock(() => ({ returning: consumedReturning })) })),
		insert: mock(() => ({ values })),
		execute,
		select,
	} as unknown as Database;
	const transaction = mock(async (callback: (database: Database) => Promise<unknown>) =>
		callback(tx),
	);
	return {
		db: {
			delete: mock(() => ({ where: mock(async () => []) })),
			insert: mock(() => ({ values: stateValues })),
			transaction,
		} as unknown as Database,
		stateValues,
		consumedReturning,
		confirmationConflict,
		transaction,
		values,
		execute,
		select,
	};
}

/** Cleanup transaction double: records deletes and answers the survivor read. */
function cleanupTransaction(options: { survivors: Array<{ tokenId: string }>; order?: string[] }) {
	const deletedTables: string[] = [];
	const database = {
		execute: mock(async () => {
			options.order?.push("lock");
			return [];
		}),
		delete: mock((table: Parameters<typeof getTableName>[0]) => ({
			where: mock(async () => {
				deletedTables.push(getTableName(table));
				options.order?.push("delete");
				return [];
			}),
		})),
		select: mock(() => ({
			from: mock(() => ({
				where: mock(() => ({
					limit: mock(async () => {
						options.order?.push("select");
						return options.survivors;
					}),
				})),
			})),
		})),
	} as unknown as Database;
	return { database, deletedTables };
}

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
	test("mints a one-time connect transaction bound to tenant, admin, and browser", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const values = mock(async () => []);
		const service = new OctokitGitHubService({
			db: {
				delete: mock(() => ({ where: mock(async () => []) })),
				insert: mock(() => ({ values })),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound: stubOutbound(),
		});

		const state = await service.beginConnect("tenant-a", "user-a", BROWSER_NONCE);
		const claims = await setupStates.verify(state);

		expect(claims).toMatchObject(CONNECT_STATE_INPUT);
		expect(claims.accountLogin).toBeUndefined();
		expect(values).toHaveBeenCalledWith({
			jti: claims.jti,
			tenantId: "tenant-a",
			expiresAt: claims.expiresAt,
		});
	});

	test("confirmConnect consumes the connect transaction and durably confirms the vaulted token exactly once", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const db = setupStateDb();
		const outbound = stubOutbound();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound,
		});

		const { state } = await setupStates.issue(CONNECT_STATE_INPUT);
		await expect(service.confirmConnect(state, BROWSER_NONCE, INITIATOR)).resolves.toEqual({
			login: "alice",
		});

		expect(db.consumedReturning).toHaveBeenCalledTimes(1);
		// The exact Descope token id the callback saw is durably confirmed, and
		// only once.
		expect(outbound.loadPendingConnection).toHaveBeenCalledTimes(1);
		expect(outbound.loadPendingConnection).toHaveBeenCalledWith("user-a", "tenant-a");
		expect(db.values).toHaveBeenCalledWith({
			tenantId: "tenant-a",
			userId: "user-a",
			tokenId: "tok-a",
		});
		expect(db.confirmationConflict).toHaveBeenCalledTimes(1);
		// Nothing about account administration is checked here: nothing is
		// selected yet.
		expect(outbound.verifyAccountAdministration).not.toHaveBeenCalled();
	});

	test("issueInstallationUrl verifies administration through the confirmed connection and issues install state", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const request = mock(async () => ({ data: { id: 123, slug: "procella" } }));
		const db = setupStateDb();
		const outbound = stubOutbound({
			verifyAccountAdministration: mock(
				async (_userId, _tenantId, _account, _confirmedTokenId, options) => {
					expect(options).toEqual({ allowInvisibleMembership: true });
				},
			),
		});
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request } as unknown as Octokit,
			setupStates,
			outbound,
		});

		const url = new URL(
			await service.issueInstallationUrl("tenant-a", "user-a", "acme", BROWSER_NONCE),
		);

		expect(url.origin + url.pathname).toBe("https://github.com/apps/procella/installations/new");
		const claims = await setupStates.verify(url.searchParams.get("state") ?? "");
		expect(claims).toMatchObject(INSTALL_STATE_INPUT);
		expect(outbound.verifyAccountAdministration).toHaveBeenCalledWith(
			"user-a",
			"tenant-a",
			"acme",
			"tok-a",
			{ allowInvisibleMembership: true },
		);
		expect(request).toHaveBeenCalledWith("GET /app");
	});

	test("refuses to confirm a connect transaction outside its own browser, tenant, or user", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(CONNECT_STATE_INPUT);
		const transaction = mock(() => {
			throw new Error("must not consume state");
		});
		const outbound = stubOutbound();
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound,
		});

		// A forwarded authorization link lands in a browser without the nonce.
		await expect(
			service.confirmConnect(state, OTHER_BROWSER_NONCE, INITIATOR),
		).rejects.toMatchObject({ code: "invalid_state" });
		// Another tenant's admin cannot continue it either.
		await expect(
			service.confirmConnect(state, BROWSER_NONCE, { ...INITIATOR, tenantId: "tenant-b" }),
		).rejects.toMatchObject({ code: "invalid_state" });
		// Nor can another user inside the same tenant.
		await expect(
			service.confirmConnect(state, BROWSER_NONCE, { ...INITIATOR, userId: "user-b" }),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(outbound.loadPendingConnection).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	test("refuses to confirm anything when the browser or caller does not match", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(CONNECT_STATE_INPUT);
		const db = setupStateDb();
		const outbound = stubOutbound();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound,
		});

		// A forwarded connect URL means Descope may already have vaulted a token,
		// but nothing confirms it, so every consumer keeps rejecting it.
		for (const attempt of [
			() => service.confirmConnect(state, OTHER_BROWSER_NONCE, INITIATOR),
			() => service.confirmConnect(state, BROWSER_NONCE, { ...INITIATOR, userId: "user-b" }),
		]) {
			await expect(attempt()).rejects.toMatchObject({ code: "invalid_state" });
		}
		expect(outbound.loadPendingConnection).not.toHaveBeenCalled();
		expect(db.confirmationConflict).not.toHaveBeenCalled();
		expect(db.transaction).not.toHaveBeenCalled();
	});

	test("fails closed when the pending token cannot be read", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(CONNECT_STATE_INPUT);
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound: stubOutbound({
				loadPendingConnection: mock(async () => {
					throw new GitHubOutboundError("authorization_required");
				}),
			}),
		});

		await expect(service.confirmConnect(state, BROWSER_NONCE, INITIATOR)).rejects.toMatchObject({
			code: "authorization_required",
		});
		// The transaction aborts under the lock, so nothing is confirmed or consumed.
		expect(db.confirmationConflict).not.toHaveBeenCalled();
		expect(db.consumedReturning).not.toHaveBeenCalled();
	});

	test("rejects an expired or replayed connect transaction", async () => {
		let now = new Date("2026-01-01T00:00:00Z");
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey, {
			now: () => now,
			ttlSeconds: 60,
		});
		const expiredDb = setupStateDb();
		const service = new OctokitGitHubService({
			db: expiredDb.db,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound: stubOutbound(),
		});

		const { state } = await setupStates.issue(CONNECT_STATE_INPUT);
		now = new Date("2026-01-01T00:01:01Z");
		await expect(service.confirmConnect(state, BROWSER_NONCE, INITIATOR)).rejects.toMatchObject({
			code: "expired_state",
		});

		now = new Date("2026-01-01T00:00:00Z");
		const replayDb = setupStateDb({ consumed: false });
		const replayService = new OctokitGitHubService({
			db: replayDb.db,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound: stubOutbound(),
		});
		const replay = await setupStates.issue(CONNECT_STATE_INPUT);
		await expect(
			replayService.confirmConnect(replay.state, BROWSER_NONCE, INITIATOR),
		).rejects.toMatchObject({ code: "replayed_state" });
	});

	test("never accepts one phase's state in the other phase", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const transaction = mock(() => {
			throw new Error("must not consume state");
		});
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			outbound: stubOutbound(),
		});
		const install = await setupStates.issue(INSTALL_STATE_INPUT);
		const connect = await setupStates.issue(CONNECT_STATE_INPUT);

		await expect(
			service.confirmConnect(install.state, BROWSER_NONCE, INITIATOR),
		).rejects.toMatchObject({ code: "invalid_state" });
		await expect(
			service.completeInstallation(connect.state, 101, BROWSER_NONCE),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(transaction).not.toHaveBeenCalled();
	});

	test("disables the GitHub service when App credentials are absent", () => {
		expect(
			buildGitHubAppConfig({ ticketSigningKey: "state-signing-key-state-signing-key" } as Config),
		).toBeNull();
	});

	test("builds App configuration without GitHub OAuth client credentials", () => {
		const config = buildGitHubAppConfig({
			githubAppId: "123",
			githubAppPrivateKey: TEST_GITHUB_APP_PRIVATE_KEY,
			githubAppWebhookSecret: "webhook-secret",
			ticketSigningKey: "state-signing-key-state-signing-key",
			githubOutboundAppId: "procella-github",
		} as Config);
		expect(config).toEqual(testConfig);
		expect(config).not.toHaveProperty("clientId");
		expect(config).not.toHaveProperty("clientSecret");
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

	test("verify rejects a connect-phase state carrying an account", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue({ ...CONNECT_STATE_INPUT, accountLogin: "acme" });
		await expect(setupStates.verify(state)).rejects.toMatchObject({ code: "invalid_state" });
	});

	test("verify rejects an install-phase state missing an account", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue({
			tenantId: "tenant-a",
			initiatorUserId: "user-a",
			browserBinding: BROWSER_BINDING,
			phase: "install",
		});
		await expect(setupStates.verify(state)).rejects.toMatchObject({ code: "invalid_state" });
	});
});

describe("OctokitGitHubService vaulted user verification", () => {
	test("verifies vaulted administration and installation access before binding", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const db = setupStateDb();
		const events: string[] = [];
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
		const outbound = stubOutbound({
			verifyAccountAdministration: mock(
				async (_userId, _tenantId, _account, _confirmedTokenId, options) => {
					events.push(
						options?.allowInvisibleMembership ? "administration-advisory" : "administration",
					);
				},
			),
			verifyInstallationAccess: mock(async () => {
				events.push("installation-access");
			}),
		});
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: appRequest } as unknown as Octokit,
			setupStates,
			outbound,
		});

		const connectState = await service.beginConnect("tenant-a", "user-a", BROWSER_NONCE);
		await service.confirmConnect(connectState, BROWSER_NONCE, INITIATOR);
		const installationUrl = new URL(
			await service.issueInstallationUrl("tenant-a", "user-a", "acme", BROWSER_NONCE),
		);
		const installationState = installationUrl.searchParams.get("state") ?? "";
		await expect(
			service.completeInstallation(installationState, 101, BROWSER_NONCE),
		).resolves.toEqual(installationRow);
		expect(events).toEqual([
			"administration-advisory",
			"installation",
			"administration",
			"installation-access",
		]);
		expect(outbound.verifyInstallationAccess).toHaveBeenCalledWith(
			"user-a",
			"tenant-a",
			101,
			"tok-a",
		);
	});

	test("issueInstallationUrl rejects a GitHub user who does not administer the requested account", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({ data: { id: 123, slug: "procella" } })),
			} as unknown as Octokit,
			setupStates,
			outbound: stubOutbound({
				verifyAccountAdministration: mock(async () => {
					throw new GitHubOutboundError("authorization_required");
				}),
			}),
		});

		await expect(
			service.issueInstallationUrl("tenant-a", "user-a", "acme", BROWSER_NONCE),
		).rejects.toMatchObject({ code: "authorization_required" });
		// The transaction aborts, so no install-phase state is ever recorded.
		expect(db.stateValues).not.toHaveBeenCalled();
	});

	test("confirmConnect treats a missing vaulted token as authorization required", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(CONNECT_STATE_INPUT);
		const service = new OctokitGitHubService({
			db: setupStateDb().db,
			config: testConfig,
			appClient: {} as Octokit,
			setupStates,
			outbound: new VaultedGitHubIdentityService(
				{
					fetchUserToken: mock(async () => ({ outcome: "absent" }) as const),
					deleteToken: mock(async () => undefined),
				},
				{ confirmedTokenId: mock(async () => null) },
			),
		});

		await expect(service.confirmConnect(state, BROWSER_NONCE, INITIATOR)).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("fails closed when vaulted verification is not configured", async () => {
		const service = new OctokitGitHubService({
			db: {} as Database,
			config: testConfig,
			appClient: {} as Octokit,
		});

		expect(service.connectAvailable).toBe(false);
		expect(await service.resolveConnectedLogin("tenant-a", "user-a")).toBeNull();
		await expect(service.beginConnect("tenant-a", "user-a", BROWSER_NONCE)).rejects.toMatchObject({
			code: "authorization_unavailable",
		});
		await expect(
			service.confirmConnect("irrelevant-state", BROWSER_NONCE, INITIATOR),
		).rejects.toMatchObject({ code: "authorization_unavailable" });
		await expect(
			service.issueInstallationUrl("tenant-a", "user-a", "acme", BROWSER_NONCE),
		).rejects.toMatchObject({ code: "authorization_unavailable" });
		await expect(service.listConnectTargets("tenant-a", "user-a")).rejects.toMatchObject({
			code: "authorization_unavailable",
		});
	});

	test("rejects tenant A callback state from tenant B browser before external calls", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const appRequest = mock(() => {
			throw new Error("must not load installation");
		});
		const transaction = mock(() => {
			throw new Error("must not consume state");
		});
		const outbound = stubOutbound();
		const service = new OctokitGitHubService({
			db: { transaction } as unknown as Database,
			config: testConfig,
			appClient: { request: appRequest } as unknown as Octokit,
			setupStates,
			outbound,
		});
		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);

		await expect(
			service.completeInstallation(state, 101, OTHER_BROWSER_NONCE),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(appRequest).not.toHaveBeenCalled();
		expect(outbound.verifyAccountAdministration).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	test("rejects a callback whose GitHub user lost installation access", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			outbound: stubOutbound({
				verifyInstallationAccess: mock(async () => {
					throw new GitHubOutboundError("authorization_required");
				}),
			}),
		});

		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).rejects.toMatchObject({
			code: "authorization_required",
		});
		// The check runs under the lock, so the transaction opens and rolls back
		// with the install state still unconsumed and no binding written.
		expect(db.consumedReturning).not.toHaveBeenCalled();
		expect(db.values).not.toHaveBeenCalled();
	});

	test("reports GitHub verification outages separately from denied administration", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			outbound: stubOutbound({
				verifyAccountAdministration: mock(async () => {
					throw new GitHubOutboundError("authorization_failed");
				}),
			}),
		});

		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(db.consumedReturning).not.toHaveBeenCalled();
		expect(db.values).not.toHaveBeenCalled();
	});

	test("never surfaces the vaulted GitHub token to callers", async () => {
		const fetchUserToken = mock(
			async () =>
				({ outcome: "found", token: { id: "tok-a", accessToken: "ghu_secret-token" } }) as const,
		);
		const userRequest = mock(async (route: string) =>
			route === "GET /user" ? { data: { login: "alice" } } : { data: {} },
		);
		const outbound = new VaultedGitHubIdentityService(
			{ fetchUserToken, deleteToken: mock(async () => undefined) },
			{ confirmedTokenId: mock(async () => "tok-a") },
			() => ({ request: userRequest }) as unknown as Octokit,
		);
		const service = new OctokitGitHubService({
			db: {} as Database,
			config: testConfig,
			appClient: {} as Octokit,
			outbound,
		});

		const login = await service.resolveConnectedLogin("tenant-a", "user-a");
		expect(login).toBe("alice");
		expect(JSON.stringify({ login })).not.toContain("ghu_secret-token");
		expect(fetchUserToken).toHaveBeenCalledWith("user-a", "tenant-a");
	});

	test("disconnect deletes the confirmed token, then confirmation and binding", async () => {
		const order: string[] = [];
		const tx = cleanupTransaction({ survivors: [], order });
		const drainTenantTokens = mock(async () => {
			order.push("token");
			return ["tok-a"] as readonly string[];
		});
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx.database),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({ drainTenantTokens }),
		});

		await service.removeInstallation("tenant-a", 101, "user-a");
		// Lock and confirmation read, then the credential, then local deletes.
		expect(order).toEqual(["lock", "select", "token", "delete", "delete"]);
		expect(tx.deletedTables).toEqual(["github_outbound_connections", "github_installations"]);
		expect(drainTenantTokens).toHaveBeenCalledWith("user-a", "tenant-a", null);
	});

	test("disconnect drains under the connection lock before removing local rows", async () => {
		const order: string[] = [];
		const tx = cleanupTransaction({ survivors: [{ tokenId: "tok-a" }], order });
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx.database),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({
				drainTenantTokens: mock(async () => {
					order.push("drain");
					return ["tok-a"] as readonly string[];
				}),
			}),
		});

		await service.removeInstallation("tenant-a", 101, "user-a");
		// Lock, then the confirmation read, then the drain, then local deletes.
		expect(order).toEqual(["lock", "select", "drain", "delete", "delete"]);
		expect(tx.deletedTables).toEqual(["github_outbound_connections", "github_installations"]);
	});

	test("disconnect passes the locked confirmation generation to the drain", async () => {
		const drainTenantTokens = mock(async () => ["tok-b"] as readonly string[]);
		const tx = cleanupTransaction({ survivors: [{ tokenId: "tok-b" }] });
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx.database),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({ drainTenantTokens }),
		});

		await service.removeInstallation("tenant-a", 101, "user-a");
		// Whatever the row says while the lock is held is what gets drained, so a
		// confirmation written by a reconnect is drained rather than orphaned.
		expect(drainTenantTokens).toHaveBeenCalledWith("user-a", "tenant-a", "tok-b");
	});

	test("disconnect keeps local state when the vaulted token cannot be deleted", async () => {
		const tx = cleanupTransaction({ survivors: [{ tokenId: "tok-a" }] });
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx.database),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({
				drainTenantTokens: mock(async () => {
					throw new GitHubOutboundError("authorization_failed");
				}),
			}),
		});

		await expect(service.removeInstallation("tenant-a", 101, "user-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
		// The transaction aborts before any local delete, so nothing is removed.
		expect(tx.deletedTables).toEqual([]);
	});

	test("disconnect refuses a confirmed connection when management is unavailable", async () => {
		const tx = cleanupTransaction({ survivors: [{ tokenId: "tok-a" }] });
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx.database),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
		});

		// The vaulted token cannot be deleted without management credentials, so
		// reporting a disconnect would leave the credential live in Descope.
		await expect(service.removeInstallation("tenant-a", 101, "user-a")).rejects.toMatchObject({
			code: "authorization_unavailable",
		});
		expect(tx.deletedTables).toEqual([]);
	});

	test("disconnect removes an unconfirmed binding when management is unavailable", async () => {
		const tx = cleanupTransaction({ survivors: [] });
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx.database),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: {} as Octokit,
		});

		// Nothing is vaulted for this tenant, so the binding can still go.
		await service.removeInstallation("tenant-a", 101, "user-a");
		expect(tx.deletedTables).toEqual(["github_outbound_connections", "github_installations"]);
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
	test("binds the App-authenticated installation after consuming install state", async () => {
		const order: string[] = [];
		const consumedReturning = mock(async () => [{ jti: "state-id" }]);
		const installationReturning = mock(async () => [installationRow]);
		const values = mock(() => ({
			onConflictDoUpdate: mock(() => ({ returning: installationReturning })),
		}));
		const tx = {
			delete: mock(() => ({
				where: mock(() => ({ returning: consumedReturning })),
			})),
			insert: mock(() => ({ values })),
			execute: mock(async () => {
				order.push("lock");
				return [];
			}),
			select: mock(() => ({
				from: mock(() => ({
					where: mock(() => ({ limit: mock(async () => [{ tokenId: "tok-a" }]) })),
				})),
			})),
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
			outbound: stubOutbound({
				verifyAccountAdministration: mock(async () => {
					order.push("verify");
				}),
			}),
		});

		const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).resolves.toEqual(
			installationRow,
		);
		expect(order).toEqual(["lock", "verify"]);
		expect(request).toHaveBeenCalledWith("GET /app/installations/{installation_id}", {
			installation_id: 101,
		});
		expect(consumedReturning).toHaveBeenCalledTimes(1);
		expect(values).toHaveBeenCalledWith({
			tenantId: "tenant-a",
			installationId: 101,
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
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
			execute: mock(async () => []),
			select: mock(() => ({
				from: mock(() => ({
					where: mock(() => ({ limit: mock(async () => [{ tokenId: "tok-a" }]) })),
				})),
			})),
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
			outbound: stubOutbound(),
		});

		const { state } = await setupStates.issue({ ...INSTALL_STATE_INPUT, tenantId: "tenant-b" });
		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).rejects.toMatchObject({
			code: "replayed_state",
		});
		expect(insert).not.toHaveBeenCalled();
	});

	test("rejects a caller-supplied installation id without consuming install state", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const cases: Array<{ code: string; request: () => Promise<unknown>; installationId: number }> =
			[
				{
					code: "invalid_installation",
					installationId: 999,
					request: async () => {
						throw Object.assign(new Error("Not Found"), { status: 404 });
					},
				},
				{
					code: "invalid_installation",
					installationId: 999,
					request: async () => ({
						data: {
							id: 999,
							app_id: 999,
							account: { login: "attacker" },
							target_type: "Organization",
							repository_selection: "all",
						},
					}),
				},
				{
					code: "unauthorized_account",
					installationId: 101,
					request: async () => ({
						data: {
							id: 101,
							app_id: 123,
							account: { login: "other-org" },
							target_type: "Organization",
							repository_selection: "all",
						},
					}),
				},
			];

		for (const testCase of cases) {
			const consumed = mock(async () => [{ jti: "install-state" }]);
			const installationInsert = mock(() => {
				throw new Error("must not persist installation");
			});
			const tx = {
				delete: mock(() => ({ where: mock(() => ({ returning: consumed })) })),
				insert: mock(() => ({ values: mock(async () => []) })),
			} as unknown as Database;
			const transaction = mock(async (callback: (database: Database) => Promise<unknown>) =>
				callback(tx),
			);
			const service = new OctokitGitHubService({
				db: { transaction, insert: installationInsert } as unknown as Database,
				config: testConfig,
				appClient: { request: mock(testCase.request) } as unknown as Octokit,
				setupStates,
				outbound: stubOutbound(),
			});

			const { state } = await setupStates.issue(INSTALL_STATE_INPUT);
			const rejection = service.completeInstallation(state, testCase.installationId, BROWSER_NONCE);
			await expect(rejection).rejects.toBeInstanceOf(GitHubSetupError);
			await expect(rejection).rejects.toMatchObject({ code: testCase.code });
			expect(consumed).not.toHaveBeenCalled();
			expect(installationInsert).not.toHaveBeenCalled();
		}
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

function connectTargetsDb(rows: Array<{ installationId: number; tenantId: string }>): Database {
	return {
		select: mock(() => ({
			from: mock(() => ({ where: mock(async () => rows) })),
		})),
	} as unknown as Database;
}

describe("OctokitGitHubService connect targets and installation", () => {
	test("excludes accounts the caller does not administer even when their installation is visible", async () => {
		const service = new OctokitGitHubService({
			db: connectTargetsDb([]),
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({
				listAdministeredAccounts: mock(
					async (): Promise<GitHubAccountCandidate[]> => [
						{ login: "acme", accountType: "Organization" },
					],
				),
				listVisibleInstallations: mock(
					async (): Promise<GitHubVisibleInstallation[]> => [
						{
							installationId: 101,
							accountLogin: "acme",
							accountType: "Organization",
							repositorySelection: "all",
						},
						{
							installationId: 202,
							accountLogin: "other-org",
							accountType: "Organization",
							repositorySelection: "all",
						},
					],
				),
			}),
		});

		await expect(service.listConnectTargets("tenant-a", "user-a")).resolves.toEqual([
			{
				accountLogin: "acme",
				accountType: "Organization",
				installationId: 101,
				connected: false,
				claimedByOtherTenant: false,
			},
		]);
	});

	test("marks connected for the caller's own tenant and claimedByOtherTenant for another", async () => {
		const service = new OctokitGitHubService({
			db: connectTargetsDb([
				{ installationId: 101, tenantId: "tenant-a" },
				{ installationId: 202, tenantId: "tenant-b" },
			]),
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({
				listAdministeredAccounts: mock(
					async (): Promise<GitHubAccountCandidate[]> => [
						{ login: "acme", accountType: "Organization" },
						{ login: "beta", accountType: "Organization" },
					],
				),
				listVisibleInstallations: mock(
					async (): Promise<GitHubVisibleInstallation[]> => [
						{
							installationId: 101,
							accountLogin: "acme",
							accountType: "Organization",
							repositorySelection: "all",
						},
						{
							installationId: 202,
							accountLogin: "beta",
							accountType: "Organization",
							repositorySelection: "all",
						},
					],
				),
			}),
		});

		await expect(service.listConnectTargets("tenant-a", "user-a")).resolves.toEqual([
			{
				accountLogin: "acme",
				accountType: "Organization",
				installationId: 101,
				connected: true,
				claimedByOtherTenant: false,
			},
			{
				accountLogin: "beta",
				accountType: "Organization",
				installationId: 202,
				connected: false,
				claimedByOtherTenant: true,
			},
		]);
	});

	test("reports installationId null for an administered account with no installation", async () => {
		const service = new OctokitGitHubService({
			db: connectTargetsDb([]),
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({
				listAdministeredAccounts: mock(
					async (): Promise<GitHubAccountCandidate[]> => [{ login: "alice", accountType: "User" }],
				),
				listVisibleInstallations: mock(async (): Promise<GitHubVisibleInstallation[]> => []),
			}),
		});

		await expect(service.listConnectTargets("tenant-a", "user-a")).resolves.toEqual([
			{
				accountLogin: "alice",
				accountType: "User",
				installationId: null,
				connected: false,
				claimedByOtherTenant: false,
			},
		]);
	});

	test("listConnectTargets fails closed with authorization_required when nothing is vaulted", async () => {
		const service = new OctokitGitHubService({
			db: connectTargetsDb([]),
			config: testConfig,
			appClient: {} as Octokit,
			outbound: stubOutbound({
				listAdministeredAccounts: mock(async () => {
					throw new GitHubOutboundError("authorization_required");
				}),
			}),
		});

		await expect(service.listConnectTargets("tenant-a", "user-a")).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("connectInstallation verifies administration without the invisible-membership escape hatch", async () => {
		const db = setupStateDb();
		const options: Array<{ allowInvisibleMembership?: boolean } | undefined> = [];
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			outbound: stubOutbound({
				verifyAccountAdministration: mock(async (_userId, _tenantId, _account, _tokenId, opts) => {
					options.push(opts);
				}),
			}),
		});

		await expect(service.connectInstallation("tenant-a", "user-a", 101)).resolves.toEqual(
			installationRow,
		);
		// No allowInvisibleMembership escape hatch: the App is already installed,
		// so a hidden organization is a denial, not a pre-installation gap.
		expect(options).toEqual([{}]);
	});

	test("connectInstallation refuses an installation the vaulted user cannot see", async () => {
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			outbound: stubOutbound({
				verifyInstallationAccess: mock(async () => {
					throw new GitHubOutboundError("authorization_required");
				}),
			}),
		});

		await expect(service.connectInstallation("tenant-a", "user-a", 101)).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("connectInstallation surfaces installation_conflict for an installation another tenant already bound", async () => {
		const tx = {
			execute: mock(async () => []),
			select: mock(() => ({
				from: mock(() => ({
					where: mock(() => ({ limit: mock(async () => [{ tokenId: "tok-a" }]) })),
				})),
			})),
			insert: mock(() => ({
				values: mock(() => ({
					onConflictDoUpdate: mock(() => ({ returning: mock(async () => []) })),
				})),
			})),
		} as unknown as Database;
		const service = new OctokitGitHubService({
			db: {
				transaction: mock(async (callback: (database: Database) => Promise<unknown>) =>
					callback(tx),
				),
			} as unknown as Database,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			outbound: stubOutbound(),
		});

		await expect(service.connectInstallation("tenant-a", "user-a", 101)).rejects.toMatchObject({
			code: "installation_conflict",
		});
	});

	test("connectInstallation fails closed when vaulted verification is not configured", async () => {
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
		});

		await expect(service.connectInstallation("tenant-a", "user-a", 101)).rejects.toMatchObject({
			code: "authorization_unavailable",
		});
	});

	test("issueInstallationUrl requires a confirmed connection", async () => {
		const service = new OctokitGitHubService({
			db: setupStateDb({ confirmedTokenId: null }).db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({ data: { id: 123, slug: "procella" } })),
			} as unknown as Octokit,
			outbound: new VaultedGitHubIdentityService(
				{
					fetchUserToken: mock(async () => ({ outcome: "absent" }) as const),
					deleteToken: mock(async () => undefined),
				},
				{ confirmedTokenId: mock(async () => null) },
			),
		});

		await expect(
			service.issueInstallationUrl("tenant-a", "user-a", "acme", BROWSER_NONCE),
		).rejects.toMatchObject({ code: "authorization_required" });
	});

	test("issueInstallationUrl binds the install state to the browser nonce it was handed", async () => {
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({ data: { id: 123, slug: "procella" } })),
			} as unknown as Octokit,
			outbound: stubOutbound(),
		});

		const url = new URL(
			await service.issueInstallationUrl("tenant-a", "user-a", "acme", BROWSER_NONCE),
		);
		const state = url.searchParams.get("state") ?? "";

		// A different browser's nonce cannot complete the install this state names.
		await expect(
			service.completeInstallation(state, 101, OTHER_BROWSER_NONCE),
		).rejects.toMatchObject({ code: "invalid_state" });
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
