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

function mockGitHubService(overrides?: Partial<GitHubService>): GitHubService {
	return {
		handleWebhookEvent: mock(async () => {}),
		connectAvailable: true,
		resolveConnectedLogin: mock(async () => "alice"),
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeInstallation: mock(async () => mockInstallation),
		listInstallations: mock(async () => [mockInstallation]),
		resolveInstallation: mock(async () => mockInstallation),
		removeInstallation: mock(async () => {}),
		createPRComment: mock(async () => 1),
		findPRComment: mock(async () => null),
		updatePRComment: mock(async () => {}),
		setCommitStatus: mock(async () => {}),
		...overrides,
	};
}

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		setGitHubSetupCookie: mock(() => {}),
		startGitHubConnect: mock(async () => "https://github.com/login/oauth/authorize?state=descope"),
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
			mockContext({ startGitHubConnect: undefined }),
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

	test("startConnect returns only the provider URL for admins", async () => {
		const ctx = mockContext();
		expect(await githubRouter.createCaller(ctx).startConnect()).toEqual({
			url: "https://github.com/login/oauth/authorize?state=descope",
		});

		const nonAdmin = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(githubRouter.createCaller(nonAdmin).startConnect()).rejects.toThrow(
			"Admin role required",
		);
	});

	test("startConnect fails closed when the outbound app is unavailable", async () => {
		await expect(
			githubRouter.createCaller(mockContext({ startGitHubConnect: undefined })).startConnect(),
		).rejects.toThrow("GitHub user verification is not configured");
		await expect(
			githubRouter
				.createCaller(mockContext({ github: mockGitHubService({ connectAvailable: false }) }))
				.startConnect(),
		).rejects.toThrow("GitHub user verification is not configured");
		await expect(
			githubRouter.createCaller(mockContext({ github: null })).startConnect(),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("createInstallationUrl binds state to the initiating admin and browser", async () => {
		const issueInstallationUrl = mock(
			async (_tenantId: string, _accountLogin: string, _userId: string, _nonce: string) =>
				"https://github.com/apps/procella/installations/new",
		);
		const ctx = mockContext({ github: mockGitHubService({ issueInstallationUrl }) });
		const result = await githubRouter
			.createCaller(ctx)
			.createInstallationUrl({ accountLogin: "acme" });
		expect(result.url).toContain("github.com/apps/procella/installations/new");
		const issueCall = issueInstallationUrl.mock.calls[0];
		expect(issueCall?.slice(0, 3)).toEqual(["t-1", "acme", "u-1"]);
		expect(issueCall?.[3]).toMatch(/^[a-zA-Z0-9_-]{43}$/);
		expect(ctx.setGitHubSetupCookie).toHaveBeenCalledWith(issueCall?.[3]);
	});

	test("createInstallationUrl rejects non-admin callers", async () => {
		const ctx = mockContext({ caller: { ...viewerCaller, roles: ["viewer"] } });
		await expect(
			githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("Admin role required");
	});

	test("createInstallationUrl reports disabled server configuration", async () => {
		await expect(
			githubRouter
				.createCaller(mockContext({ github: null }))
				.createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("GitHub App is not configured");
	});

	test("createInstallationUrl rejects malformed GitHub account logins", async () => {
		const ctx = mockContext();
		await expect(
			githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "../attacker" }),
		).rejects.toThrow();
		expect(ctx.github?.issueInstallationUrl).not.toHaveBeenCalled();
	});

	test("createInstallationUrl fails closed when browser cookie support is unavailable", async () => {
		const ctx = mockContext({ setGitHubSetupCookie: undefined });
		await expect(
			githubRouter.createCaller(ctx).createInstallationUrl({ accountLogin: "acme" }),
		).rejects.toThrow("GitHub setup cookie support is unavailable");
		expect(ctx.github?.issueInstallationUrl).not.toHaveBeenCalled();
	});

	test("createInstallationUrl maps vaulted verification failures without setting a cookie", async () => {
		const cases = [
			{ code: "authorization_required", message: "Connect a GitHub account" },
			{ code: "authorization_unavailable", message: "not configured on this server" },
			{ code: "authorization_failed", message: "could not confirm your account administration" },
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
			expect(ctx.setGitHubSetupCookie).not.toHaveBeenCalled();
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
