import { describe, expect, mock, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
	DescopeGitHubOutboundVault,
	GITHUB_OUTBOUND_DRAIN_LIMIT,
	GitHubOutboundError,
	type GitHubOutboundTokenVault,
	type GitHubVaultedTokenLookup,
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

const absent = { outcome: "absent" } as const;

/** Answers each lookup from a script, so a drain loop can be driven exactly. */
function lookupSequence(...answers: GitHubVaultedTokenLookup[]) {
	let call = 0;
	return mock(async () => answers[call++] ?? absent);
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

		// A cross-tenant answer is not proof this tenant's slot is empty.
		expect(await vaultFor(api).fetchUserToken("user-a", TENANT_B)).toEqual({ outcome: "failed" });
		expect(api.fetchToken).toHaveBeenCalledWith(APP_ID, "user-a", TENANT_B, {
			forceRefresh: false,
		});
	});

	test("reports absence only for Descope's documented not-found", async () => {
		const api = vaultApi({ fetchToken: mock(async () => ({ ok: false, code: 404 })) });

		expect(await vaultFor(api).fetchUserToken("user-a", TENANT_A)).toEqual({ outcome: "absent" });
	});

	test("reports failure for outages and for successes carrying no usable token", async () => {
		const failures: ApiOverrides[] = [
			{ fetchToken: mock(async () => ({ ok: false })) },
			{ fetchToken: mock(async () => ({ ok: false, code: 500 })) },
			{ fetchToken: mock(async () => ({ ok: false, code: 429 })) },
			{ fetchToken: mock(async () => ({ ok: true })) },
			{ fetchToken: mock(async () => ({ ok: true, data: { id: "tok-a", accessToken: "" } })) },
			{ fetchToken: mock(async () => ({ ok: true, data: { accessToken: "ghu_vaulted" } })) },
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
			service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a"),
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
			service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a"),
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
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a", {
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
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a", {
					allowInvisibleMembership: true,
				}),
			).resolves.toBeUndefined();
			// After installation the same answer is a denial.
			await expect(
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a"),
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
				service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a", options),
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
			service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a"),
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
		expect(await service.drainTenantTokens("user-a", TENANT_A, "tok-a")).toEqual(["tok-a"]);
		expect(deleteToken).toHaveBeenCalledWith("tok-a");
		expect(tokens[TENANT_A]).toBeUndefined();
		delete confirmed[TENANT_A];

		expect(await service.loadIdentity("user-a", TENANT_B)).toEqual({ login: "alice" });
		// The caller reads the confirmed id itself now; tenant A's is gone.
		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "alice", confirmed[TENANT_A] ?? null),
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
			service.verifyAccountAdministration("user-a", TENANT_A, "acme", null),
		).rejects.toMatchObject({ code: "authorization_required" });
		await expect(
			service.verifyInstallationAccess("user-a", TENANT_A, 101, null),
		).rejects.toMatchObject({
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
		// "tok-a" is what the caller confirmed; the vault now answers with a
		// different token, so it may not be used.
		await expect(
			service.verifyAccountAdministration("user-a", TENANT_A, "acme", "tok-a"),
		).rejects.toMatchObject({ code: "authorization_required" });
		await expect(
			service.verifyInstallationAccess("user-a", TENANT_A, 101, "tok-a"),
		).rejects.toMatchObject({
			code: "authorization_required",
		});
		expect(request).not.toHaveBeenCalled();
	});

	test("loadIdentity fails closed when the confirmation store is unreachable", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			{
				confirmedTokenId: mock(async () => {
					throw new Error("database unreachable");
				}),
			},
			userClient(async () => ({ data: { login: "alice" } })),
		);

		// loadIdentity is the only method that still reads the confirmation table
		// itself; every other verification now takes the confirmed id as an
		// argument instead, so a store outage cannot wedge it.
		expect(await service.loadIdentity("user-a", TENANT_A)).toBeNull();
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
			accessible.verifyInstallationAccess("user-a", TENANT_A, 101, "tok-a"),
		).resolves.toBeUndefined();
		expect(call).toBe(2);

		const denied = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			userClient(async () => ({ data: { total_count: 1, installations: [{ id: 7 }] } })),
		);
		await expect(
			denied.verifyInstallationAccess("user-a", TENANT_A, 101, "tok-a"),
		).rejects.toMatchObject({
			code: "authorization_required",
		});
	});

	test("propagates vault failures on disconnect", async () => {
		const deleteToken = mock(async () => {
			throw new GitHubOutboundError("authorization_failed");
		});
		const service = new VaultedGitHubIdentityService(
			tokenVault({ fetchUserToken: lookupSequence(found("tok-a", "ghu_vaulted")), deleteToken }),
			confirmations(),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(deleteToken).toHaveBeenCalledWith("tok-a");
	});

	test("drains every tenant token Descope reports before local removal", async () => {
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				// Abandoned and forwarded connects left C and B behind confirmed A.
				fetchUserToken: lookupSequence(
					found("tok-c", "ghu_latest"),
					found("tok-b", "ghu_older"),
					absent,
				),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
				}),
			}),
			confirmations("tok-a"),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).resolves.toEqual([
			"tok-c",
			"tok-b",
			"tok-a",
		]);
		// Nothing survives: both unconfirmed tokens and the stale confirmed id.
		expect(deleted).toEqual(["tok-c", "tok-b", "tok-a"]);
	});

	test("keeps draining across many replacements", async () => {
		const remaining = ["tok-1", "tok-2", "tok-3", "tok-4", "tok-5"];
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => {
					const next = remaining[0];
					return next ? found(next, `ghu_${next}`) : absent;
				}),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
					remaining.shift();
				}),
			}),
			confirmations("tok-1"),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-1")).resolves.toHaveLength(5);
		expect(deleted).toEqual(["tok-1", "tok-2", "tok-3", "tok-4", "tok-5"]);
	});

	test("fails closed when a deleted token keeps reappearing", async () => {
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => found("tok-a", "ghu_vaulted")),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
				}),
			}),
			confirmations("tok-a"),
		);

		// Descope claims the delete succeeded but still reports the token, so the
		// vault state is unknown and local state must survive.
		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(deleted).toEqual(["tok-a"]);
	});

	test("fails closed when the drain cap is exhausted", async () => {
		let issued = 0;
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				// A pathological vault that always has one more token.
				fetchUserToken: mock(async () => found(`tok-${issued++}`, "ghu_endless")),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
				}),
			}),
			confirmations("tok-0"),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
		expect(deleted).toHaveLength(GITHUB_OUTBOUND_DRAIN_LIMIT);
	});

	test("drains exactly the capped number of distinct tokens", async () => {
		const remaining = Array.from(
			{ length: GITHUB_OUTBOUND_DRAIN_LIMIT },
			(_value, index) => `tok-${index}`,
		);
		const deleted: string[] = [];
		const fetchUserToken = mock(async () => {
			const next = remaining[0];
			return next ? found(next, `ghu_${next}`) : absent;
		});
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken,
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
					remaining.shift();
				}),
			}),
			confirmations("tok-0"),
		);

		// The cap bounds deletions, so the lookup that proves the slot empty is
		// still allowed and the disconnect completes.
		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-0")).resolves.toHaveLength(
			GITHUB_OUTBOUND_DRAIN_LIMIT,
		);
		expect(deleted).toHaveLength(GITHUB_OUTBOUND_DRAIN_LIMIT);
		expect(fetchUserToken).toHaveBeenCalledTimes(GITHUB_OUTBOUND_DRAIN_LIMIT + 1);
	});

	test("fails closed on one token past the cap without claiming the slot is empty", async () => {
		const remaining = Array.from(
			{ length: GITHUB_OUTBOUND_DRAIN_LIMIT + 1 },
			(_value, index) => `tok-${index}`,
		);
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => {
					const next = remaining[0];
					return next ? found(next, `ghu_${next}`) : absent;
				}),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
					remaining.shift();
				}),
			}),
			confirmations("tok-0"),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-0")).rejects.toMatchObject({
			code: "authorization_failed",
		});
		// The last token stays vaulted, so the caller keeps its local state.
		expect(deleted).toHaveLength(GITHUB_OUTBOUND_DRAIN_LIMIT);
		expect(remaining).toEqual([`tok-${GITHUB_OUTBOUND_DRAIN_LIMIT}`]);
	});

	test("deletes an unconfirmed token even when nothing was ever confirmed", async () => {
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: lookupSequence(found("tok-forwarded", "ghu_victim")),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
				}),
			}),
			confirmations(null),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, null)).resolves.toEqual([
			"tok-forwarded",
		]);
		expect(deleted).toEqual(["tok-forwarded"]);
	});

	test("refuses to disconnect when the vault lookup fails or answers malformed", async () => {
		for (const fetchUserToken of [
			mock(async () => ({ outcome: "failed" }) as const),
			mock(async () => {
				throw new Error("management unreachable");
			}),
		]) {
			const deleteToken = mock(async () => undefined);
			const service = new VaultedGitHubIdentityService(
				tokenVault({ fetchUserToken, deleteToken }),
				confirmations(),
			);

			// A Descope outage, or a success carrying no usable token, must not read
			// as "already disconnected": local state stays until the credential is
			// provably gone.
			await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).rejects.toMatchObject({
				code: "authorization_failed",
			});
			expect(deleteToken).not.toHaveBeenCalled();
		}
	});

	test("still clears a stale confirmed token when the vault reports absence", async () => {
		const deleted: string[] = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault({
				fetchUserToken: mock(async () => absent),
				deleteToken: mock(async (tokenId: string) => {
					deleted.push(tokenId);
				}),
			}),
			confirmations("tok-a"),
		);

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).resolves.toEqual([
			"tok-a",
		]);
		expect(deleted).toEqual(["tok-a"]);
	});

	test("an already-deleted confirmed token cannot wedge disconnect", async () => {
		const api = vaultApi({
			fetchToken: mock(async () => ({ ok: false, code: 404 })),
			// Descope's documented not-found is proof the token is gone.
			deleteTokenById: mock(async () => ({ ok: false, code: 404 })),
		});
		const service = new VaultedGitHubIdentityService(vaultFor(api), confirmations("tok-a"));

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).resolves.toEqual([
			"tok-a",
		]);
		expect(api.deleteTokenById).toHaveBeenCalledWith("tok-a");
	});

	test("a non-404 delete rejection blocks disconnect", async () => {
		const api = vaultApi({ deleteTokenById: mock(async () => ({ ok: false, code: 500 })) });
		const service = new VaultedGitHubIdentityService(vaultFor(api), confirmations());

		await expect(service.drainTenantTokens("user-a", TENANT_A, "tok-a")).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});
});

/**
 * One confirmed token now answers all three listing routes, so each double
 * serves the whole call and every test asserts one half of its result.
 */
function candidatesClient(routes: {
	login?: string;
	memberships?: (page: number) => unknown[];
	installations?: (page: number) => { total_count: number; installations: unknown[] };
	onRequest?: (route: string, options?: unknown) => void;
}): (token: string) => Octokit {
	function requestedPage(options: unknown): number {
		// Reading the page the caller actually asked for, rather than counting
		// calls, is what makes these fixtures fail a loop that never advances.
		if (
			typeof options !== "object" ||
			options === null ||
			!("page" in options) ||
			typeof options.page !== "number" ||
			!Number.isSafeInteger(options.page) ||
			options.page < 1
		) {
			throw new Error("request did not carry a page number");
		}
		return options.page;
	}
	return userClient(async (route, options) => {
		routes.onRequest?.(route, options);
		if (route === "GET /user") return { data: { login: routes.login ?? "alice" } };
		if (route === "GET /user/memberships/orgs") {
			return { data: routes.memberships?.(requestedPage(options)) ?? [] };
		}
		if (route === "GET /user/installations") {
			return {
				data: routes.installations?.(requestedPage(options)) ?? {
					total_count: 0,
					installations: [],
				},
			};
		}
		throw new Error(`unexpected route ${route}`);
	});
}

describe("VaultedGitHubIdentityService listing", () => {
	test("lists the connected login first, then active admins sorted case-insensitively", async () => {
		const requests: Array<{ route: string; options?: unknown }> = [];
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				onRequest: (route, options) => requests.push({ route, options }),
				memberships: () => [
					{ state: "active", role: "admin", organization: { login: "Zeta" } },
					{ state: "active", role: "member", organization: { login: "acme" } },
					{ state: "active", role: "admin", organization: { login: "beta" } },
					{ state: "pending", role: "admin", organization: { login: "gamma" } },
				],
			}),
		);

		await expect((await service.listConnectCandidates("user-a", TENANT_A)).administered).toEqual([
			{ login: "alice", accountType: "User" },
			{ login: "beta", accountType: "Organization" },
			{ login: "Zeta", accountType: "Organization" },
		]);
		expect(
			requests.find((request) => request.route === "GET /user/memberships/orgs")?.options,
		).toMatchObject({ state: "active", per_page: 100, page: 1 });
	});

	test("paginates organization memberships until a short page ends it", async () => {
		const fullPage = Array.from({ length: 100 }, (_value, index) => ({
			state: "active",
			role: "admin",
			organization: { login: `org-${index}` },
		}));
		let pages = 0;
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				memberships: (page) => {
					pages = page;
					return page === 1
						? fullPage
						: [{ state: "active", role: "admin", organization: { login: "org-100" } }];
				},
			}),
		);

		const accounts = (await service.listConnectCandidates("user-a", TENANT_A)).administered;
		expect(accounts).toHaveLength(102);
		expect(pages).toBe(2);
	});

	test("fails closed with authorization_required when nothing is confirmed", async () => {
		const request = mock(async () => ({ data: {} }));
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(null),
			() => ({ request }) as unknown as Octokit,
		);

		await expect(service.listConnectCandidates("user-a", TENANT_A)).rejects.toMatchObject({
			code: "authorization_required",
		});
		expect(request).not.toHaveBeenCalled();
	});

	test("maps an organization membership lookup failure to authorization_failed", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				memberships: () => {
					throw new Error("GitHub unavailable");
				},
			}),
		);

		await expect(service.listConnectCandidates("user-a", TENANT_A)).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});

	test("lists visible installations and skips entries with an unrecognized shape", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				installations: () => ({
					total_count: 3,
					installations: [
						{
							id: 101,
							account: { login: "acme" },
							target_type: "Organization",
							repository_selection: "all",
						},
						{
							id: 102,
							account: { login: "alice" },
							target_type: "User",
							repository_selection: "selected",
						},
						{
							id: 103,
							account: null,
							target_type: "Organization",
							repository_selection: "all",
						},
					],
				}),
			}),
		);

		await expect((await service.listConnectCandidates("user-a", TENANT_A)).installations).toEqual([
			{
				installationId: 101,
				accountLogin: "acme",
				accountType: "Organization",
				repositorySelection: "all",
			},
			{
				installationId: 102,
				accountLogin: "alice",
				accountType: "User",
				repositorySelection: "selected",
			},
		]);
	});

	test("paginates visible installations using the reported total count", async () => {
		const page1 = Array.from({ length: 100 }, (_value, index) => ({
			id: index + 1,
			account: { login: `org-${index}` },
			target_type: "Organization",
			repository_selection: "all",
		}));
		let pages = 0;
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				installations: (page) => {
					pages = page;
					return {
						total_count: 101,
						installations:
							page === 1
								? page1
								: [
										{
											id: 101,
											account: { login: "org-100" },
											target_type: "Organization",
											repository_selection: "all",
										},
									],
					};
				},
			}),
		);

		const installations = (await service.listConnectCandidates("user-a", TENANT_A)).installations;
		expect(installations).toHaveLength(101);
		expect(pages).toBe(2);
	});

	test("stops paginating installations when a total count overstates the items returned", async () => {
		let pages = 0;
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				installations: (page) => {
					pages = page;
					// A total that never matches the items returned would loop
					// forever on `total_count` alone, re-appending the same page.
					return {
						total_count: 5000,
						installations: [
							{
								id: 101,
								account: { login: "acme" },
								target_type: "Organization",
								repository_selection: "all",
							},
						],
					};
				},
			}),
		);

		const installations = (await service.listConnectCandidates("user-a", TENANT_A)).installations;
		expect(installations).toHaveLength(1);
		expect(pages).toBe(1);
	});

	test("maps an installation lookup failure to authorization_failed", async () => {
		const service = new VaultedGitHubIdentityService(
			tokenVault(),
			confirmations(),
			candidatesClient({
				installations: () => {
					throw new Error("GitHub unavailable");
				},
			}),
		);

		await expect(service.listConnectCandidates("user-a", TENANT_A)).rejects.toMatchObject({
			code: "authorization_failed",
		});
	});
});
