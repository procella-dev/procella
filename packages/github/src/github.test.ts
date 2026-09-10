import { describe, expect, mock, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import { getTableName } from "drizzle-orm";
import {
	buildGitHubAppConfig,
	createGitHubSetupStateService,
	type GitHubConnectCandidates,
	type GitHubInstallationInfo,
	GitHubOutboundError,
	type GitHubOutboundIdentityService,
	GitHubSetupError,
	OctokitGitHubService,
	VaultedGitHubIdentityService,
	verifyGitHubWebhookSignature,
} from "./index.js";

const TEST_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
	modulusLength: 2048,
})
	.privateKey.export({ format: "pem", type: "pkcs1" })
	.toString();

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
		listConnectCandidates: mock(
			async (): Promise<GitHubConnectCandidates> => ({ administered: [], installations: [] }),
		),
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

	test("verify accepts an install-phase state that names no account", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const { state } = await setupStates.issue({
			tenantId: "tenant-a",
			initiatorUserId: "user-a",
			browserBinding: BROWSER_BINDING,
			phase: "install",
		});
		// GitHub's installation picker chooses the account for this state, so
		// the callback derives it instead of comparing against a claim.
		await expect(setupStates.verify(state)).resolves.toMatchObject({
			phase: "install",
			accountLogin: undefined,
		});
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

describe("OctokitGitHubService installation repositories", () => {
	test("returns stable identities for repositories visible to the tenant installation", async () => {
		const paginate = mock(async () => [
			{
				id: 22,
				name: "zeta",
				full_name: "acme/zeta",
				owner: { id: 7, login: "acme" },
				private: true,
			},
			{
				id: 11,
				name: "alpha",
				full_name: "acme/alpha",
				owner: { id: 7, login: "acme" },
				private: false,
			},
		]);
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			installationClientFactory: () => ({ paginate }) as unknown as Octokit,
		});

		await expect(service.listInstallationRepositories("tenant-a", 101)).resolves.toEqual([
			{
				id: 11,
				name: "alpha",
				fullName: "acme/alpha",
				ownerId: 7,
				ownerLogin: "acme",
				private: false,
			},
			{
				id: 22,
				name: "zeta",
				fullName: "acme/zeta",
				ownerId: 7,
				ownerLogin: "acme",
				private: true,
			},
		]);
		expect(paginate).toHaveBeenCalledWith("GET /installation/repositories", { per_page: 100 });
	});

	test("rejects an installation bound to another tenant before calling GitHub", async () => {
		const paginate = mock(async () => []);
		const service = new OctokitGitHubService({
			db: readOnlyDb([installationRow]),
			config: testConfig,
			installationClientFactory: () => ({ paginate }) as unknown as Octokit,
		});

		await expect(service.listInstallationRepositories("tenant-b", 101)).rejects.toMatchObject({
			code: "invalid_installation",
		});
		expect(paginate).not.toHaveBeenCalled();
	});
});

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
				listConnectCandidates: mock(
					async (): Promise<GitHubConnectCandidates> => ({
						administered: [{ login: "acme", accountType: "Organization" }],
						installations: [
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
					}),
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
				listConnectCandidates: mock(
					async (): Promise<GitHubConnectCandidates> => ({
						administered: [
							{ login: "acme", accountType: "Organization" },
							{ login: "beta", accountType: "Organization" },
						],
						installations: [
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
					}),
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
				listConnectCandidates: mock(
					async (): Promise<GitHubConnectCandidates> => ({
						administered: [{ login: "alice", accountType: "User" }],
						installations: [],
					}),
				),
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
				listConnectCandidates: mock(async () => {
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

	test("issueInstallationUrl without an account skips the pre-check but still needs a connection", async () => {
		const verifyAccountAdministration = mock(async () => undefined);
		const service = new OctokitGitHubService({
			db: setupStateDb().db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({ data: { id: 123, slug: "procella" } })),
			} as unknown as Octokit,
			outbound: stubOutbound({ verifyAccountAdministration }),
		});
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);

		const url = new URL(
			await service.issueInstallationUrl("tenant-a", "user-a", undefined, BROWSER_NONCE),
		);
		// GitHub's own picker chooses the account, so none is named in the state
		// and there is nothing to verify before the redirect.
		const claims = await setupStates.verify(url.searchParams.get("state") ?? "");
		expect(claims.accountLogin).toBeUndefined();
		expect(claims.phase).toBe("install");
		expect(verifyAccountAdministration).not.toHaveBeenCalled();

		const unconfirmed = new OctokitGitHubService({
			db: setupStateDb({ confirmedTokenId: null }).db,
			config: testConfig,
			appClient: {
				request: mock(async () => ({ data: { id: 123, slug: "procella" } })),
			} as unknown as Octokit,
			outbound: stubOutbound(),
		});
		await expect(
			unconfirmed.issueInstallationUrl("tenant-a", "user-a", undefined, BROWSER_NONCE),
		).rejects.toMatchObject({ code: "authorization_required" });
	});

	test("completeInstallation binds the account GitHub installed on when the state named none", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const db = setupStateDb();
		const verifyAccountAdministration = mock(async () => undefined);
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			outbound: stubOutbound({ verifyAccountAdministration }),
		});
		const { state } = await setupStates.issue({
			...INSTALL_STATE_INPUT,
			accountLogin: undefined,
		});

		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).resolves.toMatchObject({
			installationId: 101,
			accountLogin: "acme",
		});
		// The account comes from the App-authenticated installation, and it is
		// checked with no invisible-membership allowance.
		expect(verifyAccountAdministration).toHaveBeenCalledWith(
			"user-a",
			"tenant-a",
			"acme",
			"tok-a",
			{},
		);
	});

	test("completeInstallation refuses an account-less install the caller does not administer", async () => {
		const setupStates = createGitHubSetupStateService(testConfig.stateSigningKey);
		const db = setupStateDb();
		const service = new OctokitGitHubService({
			db: db.db,
			config: testConfig,
			appClient: { request: mockInstallationRequest() } as unknown as Octokit,
			setupStates,
			outbound: stubOutbound({
				verifyAccountAdministration: mock(async () => {
					throw new GitHubOutboundError("authorization_required");
				}),
			}),
		});
		const { state } = await setupStates.issue({
			...INSTALL_STATE_INPUT,
			accountLogin: undefined,
		});

		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).rejects.toMatchObject({
			code: "authorization_required",
		});
		// The transaction aborts before any installation row is written.
		expect(db.values).not.toHaveBeenCalledWith(
			expect.objectContaining({ installationId: expect.anything() }),
		);
	});
});
