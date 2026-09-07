import { describe, expect, mock, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
	DescopeGitHubOutboundVault,
	GitHubOutboundError,
	type GitHubOutboundTokenVault,
	VaultedGitHubIdentityService,
} from "./outbound.js";

const APP_ID = "procella-github";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

/** Mock responses are shaped per test, so overrides stay untyped at the seam. */
type ApiOverrides = Record<string, unknown>;

function vaultApi(overrides: ApiOverrides = {}) {
	return {
		fetchToken: mock(async () => ({
			ok: true,
			data: { id: "tok-a", accessToken: "ghu_vaulted", tenantId: TENANT_A },
		})),
		deleteTokenById: mock(async () => ({ ok: true })),
		...overrides,
	};
}

function vaultFor(api: ReturnType<typeof vaultApi>) {
	return new DescopeGitHubOutboundVault(
		api as unknown as ConstructorParameters<typeof DescopeGitHubOutboundVault>[0],
		APP_ID,
	);
}

function tokenVault(overrides: Partial<GitHubOutboundTokenVault> = {}): GitHubOutboundTokenVault {
	return {
		fetchUserToken: mock(async () => found("tok-a", "ghu_vaulted")),
		deleteToken: mock(async () => undefined),
		...overrides,
	};
}

function found(id: string, accessToken: string) {
	return { outcome: "found", token: { id, accessToken } } as const;
}

/** Confirmation stub: by default the confirmed id matches the vaulted token. */
function confirmations(tokenId: string | null = "tok-a") {
	return { confirmedTokenId: mock(async () => tokenId) };
}

function userClient(request: (route: string, options?: unknown) => Promise<unknown>) {
	return () => ({ request: mock(request) }) as unknown as Octokit;
}

describe("DescopeGitHubOutboundVault", () => {
	test("fetches the tenant-scoped token without forcing a refresh", async () => {
		const api = vaultApi();

		expect(await vaultFor(api).fetchUserToken("user-a", TENANT_A)).toEqual({
			outcome: "found",
			token: { id: "tok-a", accessToken: "ghu_vaulted" },
		});
		expect(api.fetchToken).toHaveBeenCalledWith(APP_ID, "user-a", TENANT_A, {
			forceRefresh: false,
		});
	});

	test("never accepts a token attributed to another tenant", async () => {
		const api = vaultApi();

		expect(await vaultFor(api).fetchUserToken("user-a", TENANT_B)).toEqual({ outcome: "absent" });
		expect(api.fetchToken).toHaveBeenCalledWith(APP_ID, "user-a", TENANT_B, {
			forceRefresh: false,
		});
	});

	test("reports absence only when Descope answers", async () => {
		const absent: ApiOverrides[] = [
			{ fetchToken: mock(async () => ({ ok: false, code: 404 })) },
			{ fetchToken: mock(async () => ({ ok: true, data: { id: "tok-a", accessToken: "" } })) },
			{ fetchToken: mock(async () => ({ ok: true, data: { accessToken: "ghu_vaulted" } })) },
			{ fetchToken: mock(async () => ({ ok: true })) },
		];
		for (const override of absent) {
			expect(await vaultFor(vaultApi(override)).fetchUserToken("user-a", TENANT_A)).toEqual({
				outcome: "absent",
			});
		}
	});

	test("reports failure when Descope does not answer, never absence", async () => {
		const failures: ApiOverrides[] = [
			{ fetchToken: mock(async () => ({ ok: false })) },
			{ fetchToken: mock(async () => ({ ok: false, code: 500 })) },
			{ fetchToken: mock(async () => ({ ok: false, code: 429 })) },
			{
				fetchToken: mock(async () => {
					throw new Error("management unreachable");
				}),
			},
		];
		for (const override of failures) {
			expect(await vaultFor(vaultApi(override)).fetchUserToken("user-a", TENANT_A)).toEqual({
				outcome: "failed",
			});
		}
	});

	test("deletes exactly one token by id and fails closed when declined", async () => {
		const api = vaultApi();
		await vaultFor(api).deleteToken("tok-a");
		expect(api.deleteTokenById).toHaveBeenCalledWith("tok-a");

		const declining = vaultApi({ deleteTokenById: mock(async () => ({ ok: false })) });
		await expect(vaultFor(declining).deleteToken("tok-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});
});

describe("VaultedGitHubIdentityService", () => {
	test("accepts the connected user when it owns the account", async () => {
		const fetchUserToken = mock(async () => found("tok-a", "ghu_vaulted"));
		const service = new VaultedGitHubIdentityService(
			tokenVault({ fetchUserToken }),
			confirmations(),
			userClient(async () => ({ data: { login: "Acme" } })),
		);

		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
		).resolves.toBeUndefined();
		expect(await service.loadIdentity("user-a", TENANT_A)).toEqual({ login: "Acme" });
		expect(fetchUserToken).toHaveBeenCalledWith("user-a", TENANT_A);
	});

	test("accepts an active organization administrator", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			userClient(async (route) =>
				route === "GET /user"
					? { data: { login: "alice" } }
					: { data: { state: "active", role: "admin" } },
			),
		);

		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
		).resolves.toBeUndefined();
	});

	test("rejects members and pending invites even before installation", async () => {
		for (const membership of [
			{ state: "active", role: "member" },
			{ state: "pending", role: "admin" },
		]) {
			const service = new VaultedGitHubIdentityService(
				tokenVault(),
				confirmations(),
				userClient(async (route) =>
					route === "GET /user" ? { data: { login: "alice" } } : { data: membership },
				),
			);
			await expect(
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", {
					allowInvisibleMembership: true,
				}),
			).rejects.toMatchObject({ code: "authorization_required" });
		}
	});

	test("tolerates invisible membership only on the pre-installation leg", async () => {
		for (const status of [403, 404]) {
			const service = new VaultedGitHubIdentityService(
				tokenVault(),
				confirmations(),
				userClient(async (route) => {
					if (route === "GET /user") return { data: { login: "alice" } };
					throw Object.assign(new Error("App not installed"), { status });
				}),
			);

			// Before installation a GitHub App user token cannot read organization
			// membership, so the flow may continue to the installation screen.
			await expect(
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", {
					allowInvisibleMembership: true,
				}),
			).resolves.toBeUndefined();
			// After installation the same answer is a denial.
			await expect(
				service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
			).rejects.toMatchObject({ code: "authorization_required" });
		}
	});

	test("separates GitHub outages from denied membership", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			userClient(async (route) => {
				if (route === "GET /user") return { data: { login: "alice" } };
				throw Object.assign(new Error("GitHub unavailable"), { status: 503 });
			}),
		);

		for (const options of [{}, { allowInvisibleMembership: true }]) {
			await expect(
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", options),
			).rejects.toMatchObject({ code: "authorization_failed" });
		}
	});

	test("requires a tenant-scoped token before calling GitHub", async () => {
		const request = mock(async () => ({ data: {} }));
		const service = new VaultedGitHubIdentityService(
			tokenVault({ fetchUserToken: mock(async () => ({ outcome: "absent" }) as const) }),
			confirmations(),
			() => ({ request }) as unknown as Octokit,
		);

		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
		).rejects.toMatchObject({ code: "authorization_required" });
		expect(await service.loadIdentity("user-a", TENANT_A)).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	test("isolates tenants holding confirmed connections for the same Descope user", async () => {
		const tokens: Record<string, { id: string; accessToken: string }> = {
			[TENANT_A]: { id: "tok-a", accessToken: "ghu_tenant_a" },
			[TENANT_B]: { id: "tok-b", accessToken: "ghu_tenant_b" },
		};
		const confirmed: Record<string, string> = { [TENANT_A]: "tok-a", [TENANT_B]: "tok-b" };
		const deleteToken = mock(async (tokenId: string) => {
			for (const [key, token] of Object.entries(tokens)) {
				if (token.id === tokenId) delete tokens[key];
			}
		});
		const service = new VaultedGitHubIdentityService(
			{
				fetchUserToken: mock(async (_userId: string, tenantId: string) => {
					const token = tokens[tenantId];
					return token ? found(token.id, token.accessToken) : ({ outcome: "absent" } as const);
				}),
				deleteToken,
			},
			{ confirmedTokenId: mock(async (tenantId: string) => confirmed[tenantId] ?? null) },
			userClient(async () => ({ data: { login: "alice" } })),
		);

		expect(await service.loadIdentity("user-a", TENANT_A)).toEqual({ login: "alice" });
		expect(await service.loadIdentity("user-a", TENANT_B)).toEqual({ login: "alice" });

		// Disconnecting tenant A deletes exactly that token and leaves B intact.
		await service.disconnect("user-a", TENANT_A);
		expect(deleteToken).toHaveBeenCalledWith("tok-a");
		expect(tokens[TENANT_A]).toBeUndefined();
		delete confirmed[TENANT_A];

		expect(await service.loadIdentity("user-a", TENANT_B)).toEqual({ login: "alice" });
		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "alice"),
		).rejects.toMatchObject({ code: "authorization_required" });
	});

	test("refuses an unconfirmed token, as a forwarded connect URL would vault", async () => {
		const request = mock(async () => ({ data: { login: "victim" } }));
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => found("tok-forwarded", "ghu_victim")),
			}),
			confirmations(null),
			() => ({ request }) as unknown as Octokit,
		);

		// Descope has vaulted a token, but no browser-bound callback confirmed it.
		expect(await service.loadIdentity("user-a", TENANT_A)).toBeNull();
		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
		).rejects.toMatchObject({ code: "authorization_required" });
		await expect(service.verifyInstallationAccess("user-a", TENANT_A, 101)).rejects.toMatchObject({
			code: "authorization_required",
		});
		expect(request).not.toHaveBeenCalled();

		// The pending read is the only ungated path: it exists so the callback can
		// record the id it just saw.
		expect(await service.loadPendingConnection("user-a", TENANT_A)).toEqual({
			tokenId: "tok-forwarded",
			login: "victim",
		});
	});

	test("refuses a token that replaced the confirmed one", async () => {
		const request = mock(async () => ({ data: { login: "alice" } }));
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => found("tok-replacement", "ghu_new")),
			}),
			confirmations("tok-a"),
			() => ({ request }) as unknown as Octokit,
		);

		expect(await service.loadIdentity("user-a", TENANT_A)).toBeNull();
		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
		).rejects.toMatchObject({ code: "authorization_required" });
		await expect(service.verifyInstallationAccess("user-a", TENANT_A, 101)).rejects.toMatchObject({
			code: "authorization_required",
		});
		expect(request).not.toHaveBeenCalled();
	});

	test("fails closed when the confirmation store is unreachable", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			{
				confirmedTokenId: mock(async () => {
					throw new Error("database unreachable");
				}),
			},
			userClient(async () => ({ data: { login: "alice" } })),
		);

		expect(await service.loadIdentity("user-a", TENANT_A)).toBeNull();
		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme"),
		).rejects.toMatchObject({ code: "authorization_failed" });
		await expect(service.disconnect("user-a", TENANT_A)).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});

	test("paginates installation access and rejects installations the user cannot see", async () => {
		const pages = [
			{ data: { total_count: 150, installations: [{ id: 1 }] } },
			{ data: { total_count: 150, installations: [{ id: 101 }] } },
		];
		let call = 0;
		const accessible = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			userClient(async () => pages[call++] ?? { data: { total_count: 0, installations: [] } }),
		);
		await expect(
			accessible.verifyInstallationAccess("user-a", TENANT_A, 101),
		).resolves.toBeUndefined();
		expect(call).toBe(2);

		const denied = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			userClient(async () => ({ data: { total_count: 1, installations: [{ id: 7 }] } })),
		);
		await expect(denied.verifyInstallationAccess("user-a", TENANT_A, 101)).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("propagates vault failures on disconnect", async () => {
		const deleteToken = mock(async () => {
			throw new GitHubOutboundError("authorization_failed");
		});
		const service = new VaultedGitHubIdentityService(tokenVault({ deleteToken }), confirmations());

		await expect(service.disconnect("user-a", TENANT_A)).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(deleteToken).toHaveBeenCalledWith("tok-a");
	});

	test("refuses to disconnect when the vault lookup fails", async () => {
		const deleteToken = mock(async () => undefined);
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => ({ outcome: "failed" }) as const),
				deleteToken,
			}),
			confirmations(),
		);

		// A Descope outage must not read as "already disconnected": the caller
		// keeps the tenant binding until the credential is provably gone.
		await expect(service.disconnect("user-a", TENANT_A)).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(deleteToken).not.toHaveBeenCalled();
	});

	test("treats a confirmed-absent credential as already disconnected", async () => {
		const deleteToken = mock(async () => undefined);
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => ({ outcome: "absent" }) as const),
				deleteToken,
			}),
			confirmations(),
		);

		await expect(service.disconnect("user-a", TENANT_A)).resolves.toBeUndefined();
		expect(deleteToken).not.toHaveBeenCalled();
	});

	test("skips the vault entirely when nothing is confirmed", async () => {
		const fetchUserToken = mock(async () => found("tok-a", "ghu_vaulted"));
		const deleteToken = mock(async () => undefined);
		const service = new VaultedGitHubIdentityService(
			tokenVault({ fetchUserToken, deleteToken }),
			confirmations(null),
		);

		await expect(service.disconnect("user-a", TENANT_A)).resolves.toBeUndefined();
		expect(fetchUserToken).not.toHaveBeenCalled();
		expect(deleteToken).not.toHaveBeenCalled();
	});
});
