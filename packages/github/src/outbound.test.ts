import { describe, expect, mock, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
	DescopeGitHubOutboundVault,
	type DescopeOutboundApplicationApi,
	GitHubOutboundError,
	VaultedGitHubIdentityService,
} from "./outbound.js";

const APP_ID = "procella-github";

function vaultApi(overrides: Partial<DescopeOutboundApplicationApi> = {}) {
	return {
		fetchToken: mock(async () => ({ ok: true, data: { accessToken: "ghu_vaulted" } })),
		deleteUserTokens: mock(async () => ({ ok: true })),
		...overrides,
	} satisfies DescopeOutboundApplicationApi;
}

describe("DescopeGitHubOutboundVault", () => {
	test("fetches the latest user token without forcing a refresh", async () => {
		const api = vaultApi();
		const vault = new DescopeGitHubOutboundVault(api, APP_ID);

		expect(await vault.fetchUserToken("user-a")).toBe("ghu_vaulted");
		expect(api.fetchToken).toHaveBeenCalledWith(APP_ID, "user-a", undefined, {
			forceRefresh: false,
		});
	});

	test("reports no token for declined, empty, and thrown management responses", async () => {
		const cases: Array<Partial<DescopeOutboundApplicationApi>> = [
			{ fetchToken: mock(async () => ({ ok: false })) },
			{ fetchToken: mock(async () => ({ ok: true, data: { accessToken: "" } })) },
			{ fetchToken: mock(async () => ({ ok: true })) },
			{
				fetchToken: mock(async () => {
					throw new Error("management unreachable");
				}),
			},
		];

		for (const override of cases) {
			const vault = new DescopeGitHubOutboundVault(vaultApi(override), APP_ID);
			expect(await vault.fetchUserToken("user-a")).toBeNull();
		}
	});

	test("fails closed when token deletion is declined", async () => {
		const vault = new DescopeGitHubOutboundVault(
			vaultApi({ deleteUserTokens: mock(async () => ({ ok: false })) }),
			APP_ID,
		);

		await expect(vault.deleteUserTokens("user-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});
});

function userClient(request: (route: string, options?: unknown) => Promise<unknown>) {
	return () => ({ request: mock(request) }) as unknown as Octokit;
}

describe("VaultedGitHubIdentityService", () => {
	test("accepts the connected user when it owns the account", async () => {
		const service = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => "ghu_vaulted"),
				deleteUserTokens: mock(async () => undefined),
			},
			userClient(async () => ({ data: { login: "Acme" } })),
		);

		await expect(service.verifyAccountAdministration("user-a", "acme")).resolves.toBeUndefined();
		expect(await service.loadIdentity("user-a")).toEqual({ login: "Acme" });
	});

	test("accepts an active organization administrator", async () => {
		const service = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => "ghu_vaulted"),
				deleteUserTokens: mock(async () => undefined),
			},
			userClient(async (route) =>
				route === "GET /user"
					? { data: { login: "alice" } }
					: { data: { state: "active", role: "admin" } },
			),
		);

		await expect(service.verifyAccountAdministration("user-a", "acme")).resolves.toBeUndefined();
	});

	test("rejects members, pending invites, and non-members", async () => {
		const memberships = [
			{ state: "active", role: "member" },
			{ state: "pending", role: "admin" },
		];
		for (const membership of memberships) {
			const service = new VaultedGitHubIdentityService(
				{
					fetchUserToken: mock(async () => "ghu_vaulted"),
					deleteUserTokens: mock(async () => undefined),
				},
				userClient(async (route) =>
					route === "GET /user" ? { data: { login: "alice" } } : { data: membership },
				),
			);
			await expect(service.verifyAccountAdministration("user-a", "acme")).rejects.toMatchObject({
				code: "authorization_required",
			});
		}

		const nonMember = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => "ghu_vaulted"),
				deleteUserTokens: mock(async () => undefined),
			},
			userClient(async (route) => {
				if (route === "GET /user") return { data: { login: "alice" } };
				throw Object.assign(new Error("Not Found"), { status: 404 });
			}),
		);
		await expect(nonMember.verifyAccountAdministration("user-a", "acme")).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("separates GitHub outages from denied membership", async () => {
		const service = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => "ghu_vaulted"),
				deleteUserTokens: mock(async () => undefined),
			},
			userClient(async (route) => {
				if (route === "GET /user") return { data: { login: "alice" } };
				throw Object.assign(new Error("GitHub unavailable"), { status: 503 });
			}),
		);

		await expect(service.verifyAccountAdministration("user-a", "acme")).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});

	test("requires a vaulted token before calling GitHub", async () => {
		const request = mock(async () => ({ data: {} }));
		const service = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => null),
				deleteUserTokens: mock(async () => undefined),
			},
			() => ({ request }) as unknown as Octokit,
		);

		await expect(service.verifyAccountAdministration("user-a", "acme")).rejects.toMatchObject({
			code: "authorization_required",
		});
		expect(await service.loadIdentity("user-a")).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	test("paginates installation access and rejects installations the user cannot see", async () => {
		const pages = [
			{ data: { total_count: 150, installations: [{ id: 1 }] } },
			{ data: { total_count: 150, installations: [{ id: 101 }] } },
		];
		let call = 0;
		const accessible = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => "ghu_vaulted"),
				deleteUserTokens: mock(async () => undefined),
			},
			userClient(async () => pages[call++] ?? { data: { total_count: 0, installations: [] } }),
		);
		await expect(accessible.verifyInstallationAccess("user-a", 101)).resolves.toBeUndefined();
		expect(call).toBe(2);

		const denied = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async () => "ghu_vaulted"),
				deleteUserTokens: mock(async () => undefined),
			},
			userClient(async () => ({ data: { total_count: 1, installations: [{ id: 7 }] } })),
		);
		await expect(denied.verifyInstallationAccess("user-a", 101)).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("propagates vault failures on disconnect", async () => {
		const deleteUserTokens = mock(async () => {
			throw new GitHubOutboundError("authorization_failed");
		});
		const service = new VaultedGitHubIdentityService({
			fetchUserToken: mock(async () => "ghu_vaulted"),
			deleteUserTokens,
		});

		await expect(service.disconnect("user-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(deleteUserTokens).toHaveBeenCalledWith("user-a");
	});
});
