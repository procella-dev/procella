import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import {
	type GitHubOutboundIdentityService,
	OctokitGitHubService,
	PostgresGitHubOutboundConfirmations,
	VaultedGitHubIdentityService,
} from "@procella/github";
import { getTestDb, truncateTables } from "./setup.js";

const config = {
	appId: "123",
	privateKey: "unused-in-tests",
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
	outboundAppId: "procella-github",
};

const BROWSER_NONCE = "a".repeat(43);

const installations = new Map([
	[
		101,
		{
			id: 101,
			app_id: 123,
			account: { login: "acme" },
			target_type: "Organization",
			repository_selection: "all",
		},
	],
	[
		102,
		{
			id: 102,
			app_id: 123,
			account: { login: "octocat" },
			target_type: "User",
			repository_selection: "selected",
		},
	],
	[
		201,
		{
			id: 201,
			app_id: 123,
			account: { login: "globex" },
			target_type: "Organization",
			repository_selection: "all",
		},
	],
] as const);

let db: Database;

beforeAll(() => {
	db = getTestDb();
});

afterEach(async () => {
	await truncateTables();
});

function createService(overrides: { outbound?: GitHubOutboundIdentityService } = {}) {
	const appClient = {
		request: async (route: string, input?: { installation_id: number }) => {
			if (route === "GET /app") return { data: { id: 123, slug: "procella-test" } };
			const installationId = input?.installation_id;
			const data = installations.get(installationId as 101 | 102 | 201);
			if (!data) throw Object.assign(new Error("Not Found"), { status: 404 });
			return { data };
		},
	} as unknown as Octokit;
	// Vault stub keyed by (user, tenant): each tenant admin holds its own token
	// whose GitHub user is an active organization administrator. Confirmations are
	// read from the real table, so these tests exercise the durable boundary and
	// database-level tenant isolation rather than GitHub's verification.
	const outbound: GitHubOutboundIdentityService =
		overrides.outbound ??
		new VaultedGitHubIdentityService(
			{
				fetchUserToken: async (userId, tenantId) => ({
					id: `tok-${tenantId}-${userId}`,
					accessToken: `user-token-${tenantId}`,
				}),
				deleteToken: async () => undefined,
			},
			new PostgresGitHubOutboundConfirmations(db),
			(token) =>
				({
					request: async (route: string) => {
						if (route === "GET /user/installations") {
							const visible = [...installations.values()];
							return { data: { total_count: visible.length, installations: visible } };
						}
						if (route === "GET /user") return { data: { login: `${token}-github` } };
						return { data: { state: "active", role: "admin" } };
					},
				}) as unknown as Octokit,
		);
	return new OctokitGitHubService({ db, config, appClient, outbound });
}

async function issueInstallState(
	service: OctokitGitHubService,
	tenantId: string,
	installationId: number,
): Promise<string> {
	const installation = installations.get(installationId as 101 | 102 | 201);
	if (!installation) throw new Error("Unknown test installation");
	const connectState = await service.beginConnect(
		tenantId,
		installation.account.login,
		`${tenantId}-admin`,
		BROWSER_NONCE,
	);
	const installationUrl = new URL(
		await service.issueInstallationUrl(connectState, BROWSER_NONCE, {
			tenantId,
			userId: `${tenantId}-admin`,
		}),
	);
	const installationState = installationUrl.searchParams.get("state");
	if (!installationState) throw new Error("Installation URL did not include state");
	return installationState;
}

async function bind(service: OctokitGitHubService, tenantId: string, installationId: number) {
	return service.completeInstallation(
		await issueInstallState(service, tenantId, installationId),
		installationId,
		BROWSER_NONCE,
	);
}

/** Runs the browser-bound callback so the tenant's vaulted token is confirmed. */
async function confirm(
	service: OctokitGitHubService,
	tenantId: string,
	userId: string,
	installationId: number,
): Promise<void> {
	const installation = installations.get(installationId as 101 | 102 | 201);
	if (!installation) throw new Error("Unknown test installation");
	const connectState = await service.beginConnect(
		tenantId,
		installation.account.login,
		userId,
		BROWSER_NONCE,
	);
	await service.issueInstallationUrl(connectState, BROWSER_NONCE, { tenantId, userId });
}

describe("GitHub installation binding integration", () => {
	test("isolates authorized installations across tenants", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await bind(service, "tenant-b", 201);

		expect((await service.listInstallations("tenant-a")).map((row) => row.installationId)).toEqual([
			101,
		]);
		expect((await service.listInstallations("tenant-b")).map((row) => row.installationId)).toEqual([
			201,
		]);
	});

	test("rejects cross-tenant state use for an already-bound installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);

		await expect(bind(service, "tenant-b", 101)).rejects.toMatchObject({
			code: "installation_conflict",
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
		expect(await service.listInstallations("tenant-b")).toHaveLength(0);
	});

	test("consumes setup state exactly once under concurrent callbacks", async () => {
		const service = createService();
		const state = await issueInstallState(service, "tenant-a", 101);
		const results = await Promise.allSettled([
			service.completeInstallation(state, 101, BROWSER_NONCE),
			service.completeInstallation(state, 101, BROWSER_NONCE),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: { code: "replayed_state" },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("rejects a pre-existing installation callback from a foreign browser", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		const state = await issueInstallState(service, "tenant-a", 101);

		await expect(service.completeInstallation(state, 101, "b".repeat(43))).rejects.toMatchObject({
			code: "invalid_state",
		});
		// setup_action=update re-binds the same installation for the same tenant.
		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).resolves.toMatchObject({
			tenantId: "tenant-a",
			installationId: 101,
		});
	});

	test("tenant-scoped removal cannot delete another tenant installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await service.removeInstallation("tenant-b", 101, "tenant-b-admin");
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("keeps one Descope user's confirmed tenant connections independent", async () => {
		const tokens = new Map([
			["tenant-a|user-shared", { id: "tok-a", accessToken: "user-token-tenant-a" }],
			["tenant-b|user-shared", { id: "tok-b", accessToken: "user-token-tenant-b" }],
		]);
		const deleted: string[] = [];
		const service = createService({
			outbound: new VaultedGitHubIdentityService(
				{
					fetchUserToken: async (userId, tenantId) => tokens.get(`${tenantId}|${userId}`) ?? null,
					deleteToken: async (tokenId) => {
						deleted.push(tokenId);
						for (const [key, token] of tokens) {
							if (token.id === tokenId) tokens.delete(key);
						}
					},
				},
				new PostgresGitHubOutboundConfirmations(db),
				(token) =>
					({
						request: async (route: string) => {
							if (route === "GET /user/installations") {
								const visible = [...installations.values()];
								return { data: { total_count: visible.length, installations: visible } };
							}
							if (route === "GET /user") return { data: { login: `${token}-github` } };
							return { data: { state: "active", role: "admin" } };
						},
					}) as unknown as Octokit,
			),
		});

		// A vaulted token is invisible until its browser-bound callback confirms it.
		expect(await service.resolveConnectedLogin("tenant-a", "user-shared")).toBeNull();
		await confirm(service, "tenant-a", "user-shared", 101);
		await confirm(service, "tenant-b", "user-shared", 201);

		expect(await service.resolveConnectedLogin("tenant-a", "user-shared")).toBe(
			"user-token-tenant-a-github",
		);
		expect(await service.resolveConnectedLogin("tenant-b", "user-shared")).toBe(
			"user-token-tenant-b-github",
		);

		await service.removeInstallation("tenant-a", 101, "user-shared");

		// Only tenant A's confirmed token is deleted; tenant B keeps its connection.
		expect(deleted).toEqual(["tok-a"]);
		expect(await service.resolveConnectedLogin("tenant-a", "user-shared")).toBeNull();
		expect(await service.resolveConnectedLogin("tenant-b", "user-shared")).toBe(
			"user-token-tenant-b-github",
		);
	});

	test("a forwarded connect URL leaves the vaulted token unconfirmed and unusable", async () => {
		const service = createService();

		// Descope has vaulted a token for the initiator (the stub always answers),
		// but the callback never ran in the initiating browser.
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBeNull();

		const connectState = await service.beginConnect(
			"tenant-a",
			"acme",
			"tenant-a-admin",
			BROWSER_NONCE,
		);
		await expect(
			service.issueInstallationUrl(connectState, "c".repeat(43), {
				tenantId: "tenant-a",
				userId: "tenant-a-admin",
			}),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBeNull();

		// The initiating browser confirms it, and only then is it usable.
		await service.issueInstallationUrl(connectState, BROWSER_NONCE, {
			tenantId: "tenant-a",
			userId: "tenant-a-admin",
		});
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBe(
			"user-token-tenant-a-github",
		);
	});

	test("webhooks update and delete only existing installation bindings", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);

		await service.handleWebhookEvent("installation_repositories", {
			action: "removed",
			installation: {
				id: 101,
				account: { login: "acme-renamed", type: "Organization" },
				repository_selection: "selected",
			},
		});
		expect(await service.listInstallations("tenant-a")).toMatchObject([
			{ accountLogin: "acme-renamed", repositorySelection: "selected" },
		]);

		await service.handleWebhookEvent("installation", {
			action: "deleted",
			installation: { id: 101 },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(0);
	});
});
