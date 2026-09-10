import { describe, expect, mock, test } from "bun:test";
import { type GitHubService, GitHubSetupError } from "@procella/github";
import type { TRPCContext } from "../trpc.js";
import { githubRouter } from "./github.js";

const mockInstallation = {
	id: "inst-uuid-1",
	installationId: 12345,
	tenantId: "t-1",
	accountLogin: "my-org",
	accountType: "Organization" as const,
	repositorySelection: "all" as const,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

const mockConnectTarget = {
	accountLogin: "my-org",
	accountType: "Organization" as const,
	installationId: 12345,
	connected: true,
	claimedByOtherTenant: false,
};

function mockGitHubService(overrides?: Partial<GitHubService>): GitHubService {
	return {
		handleWebhookEvent: mock(async () => {}),
		connectAvailable: true,
		resolveConnectedLogin: mock(async () => "alice"),
		beginConnect: mock(async () => "signed-connect-state"),
		confirmConnect: mock(async () => ({ login: "alice" })),
		listConnectTargets: mock(async () => [mockConnectTarget]),
		connectInstallation: mock(async () => mockInstallation),
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeInstallation: mock(async () => mockInstallation),
		listInstallations: mock(async () => [mockInstallation]),
		listInstallationRepositories: mock(async () => []),
		removeInstallation: mock(async () => {}),
		...overrides,
	};
}

const adminCaller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "admin",
	roles: ["admin"],
	principalType: "user",
} satisfies NonNullable<TRPCContext["caller"]>;

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: adminCaller,
		setGitHubSetupCookie: mock(() => {}),
		githubSetupNonce: "n".repeat(43),
		appOrigin: "https://app.procella.test",
		githubOutboundAppId: "procella-github",
		resolveUserDisplayName: (subject) => Promise.resolve(subject),
		db: {} as never,
		notifications: {} as never,
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: mockGitHubService(),
		...overrides,
	};
}

const viewerCaller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-2",
	login: "viewer",
	roles: ["viewer"] as const,
	principalType: "user" as const,
};

describe("githubRouter", () => {
	test("status distinguishes server configuration from tenant installations", async () => {
		const configured = await githubRouter.createCaller(mockContext()).status();
		expect(configured).toEqual({
			configured: true,
			connectAvailable: true,
			connectedLogin: "alice",
			installations: [mockInstallation],
		});

		const unavailable = await githubRouter.createCaller(mockContext({ github: null })).status();
		expect(unavailable).toEqual({
			configured: false,
			connectAvailable: false,
			connectedLogin: null,
			installations: [],
		});
	});

	test("status reports connect unavailable without probing the vault", async () => {
		for (const ctx of [
			mockContext({ github: mockGitHubService({ connectAvailable: false }) }),
			mockContext({ appOrigin: undefined }),
			mockContext({ githubOutboundAppId: undefined }),
		]) {
			const status = await githubRouter.createCaller(ctx).status();
			expect(status).toMatchObject({ connectAvailable: false, connectedLogin: null });
			expect(ctx.github?.resolveConnectedLogin).not.toHaveBeenCalled();
		}
	});

	test("status is available to non-admin members", async () => {
		const ctx = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		expect((await githubRouter.createCaller(ctx).status()).configured).toBe(true);
	});

	test("repositories are limited to the caller's bound installation", async () => {
		const repositories = [
			{
				id: 44,
				name: "infra",
				fullName: "my-org/infra",
				ownerId: 12,
				ownerLogin: "my-org",
				private: true,
			},
		];
		const listInstallationRepositories = mock(async () => repositories);
		const ctx = mockContext({
			github: mockGitHubService({ listInstallationRepositories }),
		});

		await expect(
			githubRouter.createCaller(ctx).repositories({ installationId: 12345 }),
		).resolves.toEqual({ repositories });
		expect(listInstallationRepositories).toHaveBeenCalledWith("t-1", 12345);
	});

	test("startConnect returns only appId, tenantId, and a server-built redirect URL for admins", async () => {
		const ctx = mockContext();
		expect(await githubRouter.createCaller(ctx).startConnect({})).toEqual({
			appId: "procella-github",
			tenantId: "t-1",
			redirectUrl: "https://app.procella.test/settings/github/connected?state=signed-connect-state",
		});

		const nonAdmin = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(githubRouter.createCaller(nonAdmin).startConnect({})).rejects.toThrow(
			"Admin role required",
		);
	});

	test("startConnect no longer accepts or forwards an account", async () => {
		const beginConnect = mock(async () => "signed-connect-state");
		const ctx = mockContext({ github: mockGitHubService({ beginConnect }) });

		// zod strips unrecognized input keys, so a legacy client still sending
		// accountLogin never reaches the service, and beginConnect is called
		// with exactly the tenant, the initiator, and a fresh browser nonce.
		await githubRouter
			.createCaller(ctx)
			.startConnect({ accountLogin: "acme" } as unknown as Record<string, never>);

		expect(beginConnect).toHaveBeenCalledTimes(1);
		const call = beginConnect.mock.calls[0] as unknown as unknown[];
		expect(call).toHaveLength(3);
		expect(call.slice(0, 2)).toEqual(["t-1", "u-1"]);
	});

	test("startConnect rejects machine principals before creating setup state", async () => {
		for (const principalType of ["token", "workload"] as const) {
			const beginConnect = mock(async () => "signed-connect-state");
			const ctx = mockContext({
				caller: { ...adminCaller, principalType },
				github: mockGitHubService({ beginConnect }),
			});

			await expect(githubRouter.createCaller(ctx).startConnect({})).rejects.toThrow(
				"interactive user session",
			);
			expect(beginConnect).not.toHaveBeenCalled();
		}
	});

	test("startConnect fails closed when the outbound app is unavailable", async () => {
		await expect(
			githubRouter.createCaller(mockContext({ appOrigin: undefined })).startConnect({}),
		).rejects.toThrow("GitHub user verification is not configured");
		await expect(
			githubRouter.createCaller(mockContext({ githubOutboundAppId: undefined })).startConnect({}),
		).rejects.toThrow("GitHub user verification is not configured");
		await expect(
			githubRouter
				.createCaller(mockContext({ github: mockGitHubService({ connectAvailable: false }) }))
				.startConnect({}),
		).rejects.toThrow("GitHub user verification is not configured");
		await expect(
			githubRouter.createCaller(mockContext({ github: null })).startConnect({}),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("startConnect mints a browser-bound transaction and sets the cookie before returning", async () => {
		const beginConnect = mock(async () => "signed-connect-state");
		const ctx = mockContext({
			github: mockGitHubService({ beginConnect }),
		});

		expect(await githubRouter.createCaller(ctx).startConnect({})).toEqual({
			appId: "procella-github",
			tenantId: "t-1",
			redirectUrl: "https://app.procella.test/settings/github/connected?state=signed-connect-state",
		});
		const [tenantId, userId, nonce] = beginConnect.mock.calls[0] as unknown as [
			string,
			string,
			string,
		];
		expect([tenantId, userId]).toEqual(["t-1", "u-1"]);
		expect(nonce).toMatch(/^[a-zA-Z0-9_-]{43}$/);
		// The setup cookie is set before the mutation returns, so it always exists
		// before the browser's own SDK can start the outbound OAuth handoff.
		expect(ctx.setGitHubSetupCookie).toHaveBeenCalledWith(nonce);
	});

	test("startConnect keeps an existing browser nonce so a parallel install survives", async () => {
		const beginConnect = mock(async () => "signed-connect-state");
		const ctx = mockContext({ github: mockGitHubService({ beginConnect }) });

		await githubRouter.createCaller(ctx).startConnect({});

		// Re-authorizing must not replace the binding an install issued in
		// another tab will be checked against.
		const [, , nonce] = beginConnect.mock.calls[0] as unknown as [string, string, string];
		expect(nonce).toBe("n".repeat(43));
		expect(ctx.setGitHubSetupCookie).toHaveBeenCalledWith(nonce);
	});

	test("startConnect never lets client input influence the redirect origin", async () => {
		const beginConnect = mock(async () => "signed-connect-state");
		const ctx = mockContext({
			github: mockGitHubService({ beginConnect }),
			appOrigin: "https://trusted.procella.test",
		});

		// zod strips unrecognized input keys, so an attacker-supplied origin or
		// redirect URL never reaches the server logic in the first place; the
		// redirect always comes from the server's own configured appOrigin.
		const result = await githubRouter.createCaller(ctx).startConnect({
			redirectUrl: "https://evil.example/steal",
			appOrigin: "https://evil.example",
		} as unknown as Record<string, never>);

		expect(result.redirectUrl.startsWith("https://trusted.procella.test/")).toBe(true);
		expect(result.redirectUrl).not.toContain("evil.example");
	});

	test("startConnect never sets a cookie when beginConnect fails", async () => {
		const failing = mockContext({
			github: mockGitHubService({
				beginConnect: mock(async () => {
					throw new GitHubSetupError("authorization_unavailable");
				}),
			}),
		});
		await expect(githubRouter.createCaller(failing).startConnect({})).rejects.toThrow(
			"not configured on this server",
		);
		expect(failing.setGitHubSetupCookie).not.toHaveBeenCalled();
	});

	test("confirmConnect returns the confirmed login", async () => {
		const confirmConnect = mock(async () => ({ login: "alice" }));
		const ctx = mockContext({ github: mockGitHubService({ confirmConnect }) });

		const result = await githubRouter
			.createCaller(ctx)
			.confirmConnect({ state: "signed-connect-state" });

		expect(result).toEqual({ login: "alice" });
		expect(confirmConnect).toHaveBeenCalledWith("signed-connect-state", "n".repeat(43), {
			tenantId: "t-1",
			userId: "u-1",
		});
	});

	test("confirmConnect rejects non-admin callers", async () => {
		const ctx = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(
			githubRouter.createCaller(ctx).confirmConnect({ state: "signed-connect-state" }),
		).rejects.toThrow("Admin role required");
	});

	test("confirmConnect rejects machine principals before calling the service", async () => {
		for (const principalType of ["token", "workload"] as const) {
			const confirmConnect = mock(async () => ({ login: "alice" }));
			const ctx = mockContext({
				caller: { ...adminCaller, principalType },
				github: mockGitHubService({ confirmConnect }),
			});

			await expect(
				githubRouter.createCaller(ctx).confirmConnect({ state: "signed-connect-state" }),
			).rejects.toThrow("interactive user session");
			expect(confirmConnect).not.toHaveBeenCalled();
		}
	});

	test("confirmConnect fails closed without the initiating browser nonce", async () => {
		const ctx = mockContext({ githubSetupNonce: undefined });
		await expect(
			githubRouter.createCaller(ctx).confirmConnect({ state: "signed-connect-state" }),
		).rejects.toThrow("could not be verified");
		expect(ctx.github?.confirmConnect).not.toHaveBeenCalled();
	});

	test("confirmConnect reports disabled server configuration", async () => {
		await expect(
			githubRouter
				.createCaller(mockContext({ github: null }))
				.confirmConnect({ state: "signed-connect-state" }),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("confirmConnect maps transaction and verification failures", async () => {
		const cases = [
			{ code: "authorization_unavailable", message: "not configured on this server" },
			{ code: "invalid_state", message: "could not be verified" },
			{ code: "expired_state", message: "expired" },
			{ code: "replayed_state", message: "already used" },
		] as const;

		for (const { code, message } of cases) {
			const ctx = mockContext({
				github: mockGitHubService({
					confirmConnect: mock(async () => {
						throw new GitHubSetupError(code);
					}),
				}),
			});
			await expect(
				githubRouter.createCaller(ctx).confirmConnect({ state: "signed-connect-state" }),
			).rejects.toThrow(message);
		}
	});

	test("connectTargets returns the accounts the connected identity administers", async () => {
		const listConnectTargets = mock(async () => [mockConnectTarget]);
		const ctx = mockContext({ github: mockGitHubService({ listConnectTargets }) });

		const result = await githubRouter.createCaller(ctx).connectTargets();

		expect(result).toEqual({ targets: [mockConnectTarget] });
		expect(listConnectTargets).toHaveBeenCalledWith("t-1", "u-1");
	});

	test("connectTargets rejects non-admin callers", async () => {
		const ctx = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(githubRouter.createCaller(ctx).connectTargets()).rejects.toThrow(
			"Admin role required",
		);
	});

	test("connectTargets rejects machine principals before calling the service", async () => {
		for (const principalType of ["token", "workload"] as const) {
			const listConnectTargets = mock(async () => [mockConnectTarget]);
			const ctx = mockContext({
				caller: { ...adminCaller, principalType },
				github: mockGitHubService({ listConnectTargets }),
			});

			await expect(githubRouter.createCaller(ctx).connectTargets()).rejects.toThrow(
				"interactive user session",
			);
			expect(listConnectTargets).not.toHaveBeenCalled();
		}
	});

	test("connectTargets reports disabled server configuration", async () => {
		await expect(
			githubRouter.createCaller(mockContext({ github: null })).connectTargets(),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("connectTargets fails closed without a confirmed connection", async () => {
		const ctx = mockContext({
			github: mockGitHubService({
				listConnectTargets: mock(async () => {
					throw new GitHubSetupError("authorization_required");
				}),
			}),
		});
		await expect(githubRouter.createCaller(ctx).connectTargets()).rejects.toThrow(
			"Connect a GitHub account",
		);
	});

	test("connectInstallation forwards tenant, user, and installation id", async () => {
		const connectInstallation = mock(async () => mockInstallation);
		const ctx = mockContext({ github: mockGitHubService({ connectInstallation }) });

		const result = await githubRouter
			.createCaller(ctx)
			.connectInstallation({ installationId: 12345 });

		expect(result).toEqual({ installation: mockInstallation });
		expect(connectInstallation).toHaveBeenCalledWith("t-1", "u-1", 12345);
	});

	test("connectInstallation rejects non-admin callers", async () => {
		const ctx = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(
			githubRouter.createCaller(ctx).connectInstallation({ installationId: 12345 }),
		).rejects.toThrow("Admin role required");
	});

	test("connectInstallation rejects machine principals before calling the service", async () => {
		for (const principalType of ["token", "workload"] as const) {
			const connectInstallation = mock(async () => mockInstallation);
			const ctx = mockContext({
				caller: { ...adminCaller, principalType },
				github: mockGitHubService({ connectInstallation }),
			});

			await expect(
				githubRouter.createCaller(ctx).connectInstallation({ installationId: 12345 }),
			).rejects.toThrow("interactive user session");
			expect(connectInstallation).not.toHaveBeenCalled();
		}
	});

	test("connectInstallation reports disabled server configuration", async () => {
		await expect(
			githubRouter
				.createCaller(mockContext({ github: null }))
				.connectInstallation({ installationId: 12345 }),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("connectInstallation surfaces installation_conflict as CONFLICT", async () => {
		const ctx = mockContext({
			github: mockGitHubService({
				connectInstallation: mock(async () => {
					throw new GitHubSetupError("installation_conflict");
				}),
			}),
		});
		const error = await githubRouter
			.createCaller(ctx)
			.connectInstallation({ installationId: 12345 })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "CONFLICT" });
	});

	test("connectInstallation surfaces invalid_installation as BAD_REQUEST", async () => {
		const ctx = mockContext({
			github: mockGitHubService({
				connectInstallation: mock(async () => {
					throw new GitHubSetupError("invalid_installation");
				}),
			}),
		});
		const error = await githubRouter
			.createCaller(ctx)
			.connectInstallation({ installationId: 12345 })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "BAD_REQUEST" });
	});

	test("connectInstallation surfaces unauthorized_account as BAD_REQUEST", async () => {
		const ctx = mockContext({
			github: mockGitHubService({
				connectInstallation: mock(async () => {
					throw new GitHubSetupError("unauthorized_account");
				}),
			}),
		});
		const error = await githubRouter
			.createCaller(ctx)
			.connectInstallation({ installationId: 12345 })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "BAD_REQUEST" });
	});

	test("createInstallationUrl keeps the browser's nonce so a parallel install stays completable", async () => {
		const issueInstallationUrl = mock(
			async () => "https://github.com/apps/procella/installations/new",
		);
		const ctx = mockContext({ github: mockGitHubService({ issueInstallationUrl }) });

		const result = await githubRouter
			.createCaller(ctx)
			.createInstallationUrl({ accountLogin: "acme" });

		expect(result.url).toContain("github.com/apps/procella/installations/new");
		const [tenantId, userId, accountLogin, nonce] = issueInstallationUrl.mock
			.calls[0] as unknown as [string, string, string, string];
		expect([tenantId, userId, accountLogin]).toEqual(["t-1", "u-1", "acme"]);
		// Reusing the cookie's nonce is what lets an install started in another
		// tab still verify its callback; the cookie is refreshed so the binding
		// outlives the new state's TTL.
		expect(nonce).toBe("n".repeat(43));
		expect(ctx.setGitHubSetupCookie).toHaveBeenCalledWith(nonce);
	});

	test("createInstallationUrl mints a browser nonce when none exists yet", async () => {
		const issueInstallationUrl = mock(
			async () => "https://github.com/apps/procella/installations/new",
		);
		const ctx = mockContext({
			github: mockGitHubService({ issueInstallationUrl }),
			githubSetupNonce: undefined,
		});

		await githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" });

		const [, , , nonce] = issueInstallationUrl.mock.calls[0] as unknown as [
			string,
			string,
			string,
			string,
		];
		expect(nonce).toMatch(/^[a-zA-Z0-9_-]{43}$/);
		expect(ctx.setGitHubSetupCookie).toHaveBeenCalledWith(nonce);
	});

	test("createInstallationUrl forwards no account when GitHub picks the target", async () => {
		const issueInstallationUrl = mock(
			async () => "https://github.com/apps/procella/installations/new",
		);
		const ctx = mockContext({ github: mockGitHubService({ issueInstallationUrl }) });

		await githubRouter.createCaller(ctx).createInstallationUrl({});

		// Organizations without the App installed cannot be listed, so the
		// account has to be chosen on GitHub and derived from the callback.
		const [tenantId, userId, accountLogin] = issueInstallationUrl.mock.calls[0] as unknown as [
			string,
			string,
			string | undefined,
			string,
		];
		expect([tenantId, userId]).toEqual(["t-1", "u-1"]);
		expect(accountLogin).toBeUndefined();
	});

	test("createInstallationUrl never renews the browser cookie on failure", async () => {
		const ctx = mockContext({
			github: mockGitHubService({
				issueInstallationUrl: mock(async () => {
					throw new GitHubSetupError("replayed_state");
				}),
			}),
		});

		await expect(
			githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("already used");
		expect(ctx.setGitHubSetupCookie).not.toHaveBeenCalled();

		const withoutCookieSupport = mockContext({ setGitHubSetupCookie: undefined });
		await expect(
			githubRouter
				.createCaller(withoutCookieSupport)
				.createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("GitHub setup cookie support is unavailable");
		expect(withoutCookieSupport.github?.issueInstallationUrl).not.toHaveBeenCalled();
	});

	test("createInstallationUrl rejects non-admin callers", async () => {
		const ctx = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(
			githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("Admin role required");
	});

	test("createInstallationUrl rejects machine principals before calling the service", async () => {
		for (const principalType of ["token", "workload"] as const) {
			const issueInstallationUrl = mock(
				async () => "https://github.com/apps/procella/installations/new",
			);
			const ctx = mockContext({
				caller: { ...adminCaller, principalType },
				github: mockGitHubService({ issueInstallationUrl }),
			});

			await expect(
				githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" }),
			).rejects.toThrow("interactive user session");
			expect(issueInstallationUrl).not.toHaveBeenCalled();
		}
	});

	test("createInstallationUrl reports disabled server configuration", async () => {
		await expect(
			githubRouter
				.createCaller(mockContext({ github: null }))
				.createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("createInstallationUrl rejects malformed accounts before calling the service", async () => {
		const ctx = mockContext();
		await expect(
			githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "../attacker" }),
		).rejects.toThrow();
		expect(ctx.github?.issueInstallationUrl).not.toHaveBeenCalled();
		expect(ctx.setGitHubSetupCookie).not.toHaveBeenCalled();
	});

	test("createInstallationUrl maps transaction and verification failures", async () => {
		const cases = [
			{ code: "authorization_required", message: "Connect a GitHub account" },
			{ code: "authorization_unavailable", message: "not configured on this server" },
			{ code: "authorization_failed", message: "could not confirm your account administration" },
			{ code: "invalid_state", message: "could not be verified" },
			{ code: "expired_state", message: "expired" },
			{ code: "replayed_state", message: "already used" },
			{ code: "unauthorized_account", message: "different account" },
		] as const;

		for (const { code, message } of cases) {
			const ctx = mockContext({
				github: mockGitHubService({
					issueInstallationUrl: mock(async () => {
						throw new GitHubSetupError(code);
					}),
				}),
			});
			await expect(
				githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" }),
			).rejects.toThrow(message);
		}
	});

	test("removeInstallation disconnects the caller's vaulted token, tenant scoped", async () => {
		const ctx = mockContext();
		expect(
			await githubRouter.createCaller(ctx).removeInstallation({ installationId: 12345 }),
		).toEqual({ success: true });
		expect(ctx.github?.removeInstallation).toHaveBeenCalledWith("t-1", 12345, "u-1");

		const nonAdmin = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(
			githubRouter.createCaller(nonAdmin).removeInstallation({ installationId: 12345 }),
		).rejects.toThrow("Admin role required");
	});

	test("removeInstallation surfaces a failed vaulted-token deletion", async () => {
		const ctx = mockContext({
			github: mockGitHubService({
				removeInstallation: mock(async () => {
					throw new GitHubSetupError("authorization_failed");
				}),
			}),
		});
		await expect(
			githubRouter.createCaller(ctx).removeInstallation({ installationId: 12345 }),
		).rejects.toThrow("could not confirm your account administration");
	});
});
