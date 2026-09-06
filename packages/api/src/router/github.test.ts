import { describe, expect, mock, test } from "bun:test";
import type { GitHubService } from "@procella/github";
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
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeAuthorization: mock(async () => mockInstallation),
		completeInstallation: mock(async () => ({
			url: "https://github.com/login/oauth/authorize?state=authorization-state",
			authorizationState: "authorization-state",
		})),
		resumeAuthorization: mock(async () => ({
			url: "https://github.com/login/oauth/authorize?state=authorization-state",
			accountLogin: "acme",
		})),
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

describe("githubRouter", () => {
	test("status distinguishes server configuration from tenant installations", async () => {
		const configured = await githubRouter.createCaller(mockContext()).status();
		expect(configured).toEqual({
			configured: true,
			installations: [mockInstallation],
			pendingAuthorization: null,
		});

		const unavailable = await githubRouter.createCaller(mockContext({ github: null })).status();
		expect(unavailable).toEqual({
			configured: false,
			installations: [],
			pendingAuthorization: null,
		});
	});

	test("status reports a resumable authorization for the initiating admin browser", async () => {
		const ctx = mockContext({
			githubSetupCookies: { nonce: "a".repeat(43), authorizationState: "authorization-state" },
		});
		const status = await githubRouter.createCaller(ctx).status();
		expect(status.pendingAuthorization).toEqual({
			url: "https://github.com/login/oauth/authorize?state=authorization-state",
			accountLogin: "acme",
		});
		expect(ctx.github?.resumeAuthorization).toHaveBeenCalledWith(
			"authorization-state",
			"a".repeat(43),
			{ tenantId: "t-1", userId: "u-1" },
		);
	});

	test("status hides resumable authorization from non-admin callers", async () => {
		const ctx = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
			githubSetupCookies: { nonce: "a".repeat(43), authorizationState: "authorization-state" },
		});
		expect((await githubRouter.createCaller(ctx).status()).pendingAuthorization).toBeNull();
		expect(ctx.github?.resumeAuthorization).not.toHaveBeenCalled();
	});

	test("status is available to non-admin members", async () => {
		const ctx = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
		});
		expect((await githubRouter.createCaller(ctx).status()).configured).toBe(true);
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
		const ctx = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
		});
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
	test("removeInstallation is tenant scoped and admin only", async () => {
		const ctx = mockContext();
		expect(
			await githubRouter.createCaller(ctx).removeInstallation({ installationId: 12345 }),
		).toEqual({ success: true });
		expect(ctx.github?.removeInstallation).toHaveBeenCalledWith("t-1", 12345);

		const nonAdmin = mockContext({
			caller: {
				tenantId: "t-1",
				orgSlug: "my-org",
				userId: "u-2",
				login: "viewer",
				roles: ["viewer"],
				principalType: "user",
			},
		});
		await expect(
			githubRouter.createCaller(nonAdmin).removeInstallation({ installationId: 12345 }),
		).rejects.toThrow("Admin role required");
	});
});
