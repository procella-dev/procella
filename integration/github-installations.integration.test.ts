import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import { OctokitGitHubService } from "@procella/github";
import { getTestDb, truncateTables } from "./setup.js";

const config = {
	appId: "123",
	clientId: "Iv1.test-client-id",
	clientSecret: "oauth-client-secret",
	privateKey: "unused-in-tests",
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
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

function createService() {
	const appClient = {
		request: async (route: string, input?: { installation_id: number }) => {
			if (route === "GET /app") return { data: { id: 123, slug: "procella-test" } };
			const installationId = input?.installation_id;
			const data = installations.get(installationId as 101 | 102 | 201);
			if (!data) throw Object.assign(new Error("Not Found"), { status: 404 });
			return { data };
		},
	} as unknown as Octokit;
	const oauthFetch = async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("login/oauth/access_token")) {
			const code = (init?.body as URLSearchParams).get("code");
			return new Response(
				JSON.stringify({ access_token: `user-token-${code}`, token_type: "bearer" }),
			);
		}
		return new Response(null, { status: 204 });
	};
	const userClientFactory = (token: string) => {
		const accountLogin = token.replace("user-token-", "");
		const installation = [...installations.values()].find(
			(candidate) => candidate.account.login === accountLogin,
		);
		return {
			request: async (route: string) => {
				if (route === "GET /user/installations") {
					return {
						data: {
							total_count: installation ? 1 : 0,
							installations: installation ? [{ id: installation.id }] : [],
						},
					};
				}
				if (route === "GET /user") {
					return { data: { login: accountLogin === "octocat" ? "octocat" : "tenant-admin" } };
				}
				return { data: { state: "active", role: "admin" } };
			},
		} as unknown as Octokit;
	};
	return new OctokitGitHubService({
		db,
		config,
		appClient,
		oauthFetch: oauthFetch as typeof fetch,
		userClientFactory,
	});
}

async function issueAuthorizationState(
	service: OctokitGitHubService,
	tenantId: string,
	installationId: number,
): Promise<string> {
	const installation = installations.get(installationId as 101 | 102 | 201);
	if (!installation) throw new Error("Unknown test installation");
	const installationUrl = new URL(
		await service.issueInstallationUrl(
			tenantId,
			installation.account.login,
			`${tenantId}-admin`,
			BROWSER_NONCE,
		),
	);
	const installationState = installationUrl.searchParams.get("state");
	if (!installationState) throw new Error("Installation URL did not include state");
	const authorization = await service.completeInstallation(
		installationState,
		installationId,
		BROWSER_NONCE,
	);
	return authorization.authorizationState;
}

async function bind(service: OctokitGitHubService, tenantId: string, installationId: number) {
	const installation = installations.get(installationId as 101 | 102 | 201);
	if (!installation) throw new Error("Unknown test installation");
	return service.completeAuthorization(
		await issueAuthorizationState(service, tenantId, installationId),
		installation.account.login,
		BROWSER_NONCE,
	);
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
		const state = await issueAuthorizationState(service, "tenant-a", 101);
		const results = await Promise.allSettled([
			service.completeAuthorization(state, "acme", BROWSER_NONCE),
			service.completeAuthorization(state, "acme", BROWSER_NONCE),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: { code: "replayed_state" },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("tenant-scoped removal cannot delete another tenant installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await service.removeInstallation("tenant-b", 101);
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
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
