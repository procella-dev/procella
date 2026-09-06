import { describe, expect, mock, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import { GITHUB_SETUP_COOKIE_NAME, type GitHubService } from "@procella/github";
import type { StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { createSubscriptionTicketService } from "../subscription-tickets.js";
import { createWebApp } from "./web.js";

const signingKey = "ticket-signing-key-ticket-signing-key";
const subscriptionTickets = createSubscriptionTicketService(signingKey);

const validCaller: Caller = {
	tenantId: "tenant-1",
	orgSlug: "my-org",
	userId: "user-1",
	login: "alice",
	roles: ["admin"],
	principalType: "user",
};

function mockAuthService(): AuthService {
	return {
		authenticate: async (request: Request) => {
			const header = request.headers.get("Authorization");
			const cookie = request.headers.get("Cookie");
			if (header !== "token valid-token" && cookie !== "DS=session-cookie") {
				throw new UnauthorizedError("Invalid token");
			}
			return validCaller;
		},
		authenticateUpdateToken: async () => ({ updateId: "u-1", stackId: "s-1" }),
		resolveUserDisplayName: async () => null,
		createCliAccessKey: async () => "cli-token",
	};
}

function mockGitHubService(): GitHubService {
	return {
		handleWebhookEvent: mock(async () => {}),
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeInstallation: mock(async () => ({
			url: "https://github.com/login/oauth/authorize",
			authorizationState: "authorization-state",
		})),
		resumeAuthorization: mock(async () => ({
			url: "https://github.com/login/oauth/authorize",
			accountLogin: "acme",
		})),
		completeAuthorization: mock(async () => ({
			id: "row-1",
			tenantId: validCaller.tenantId,
			installationId: 101,
			accountLogin: "acme",
			accountType: "Organization" as const,
			repositorySelection: "all" as const,
			createdAt: new Date(),
			updatedAt: new Date(),
		})),
		listInstallations: mock(async () => []),
		resolveInstallation: mock(async () => null),
		removeInstallation: mock(async () => {}),
		createPRComment: mock(async () => 1),
		findPRComment: mock(async () => null),
		updatePRComment: mock(async () => {}),
		setCommitStatus: mock(async () => {}),
	};
}

function makeApp(overrides?: {
	issueSubscriptionTicket?: (caller: Caller) => Promise<string>;
	verifySubscriptionTicket?: (ticket: string) => Promise<Caller>;
	auth?: AuthService;
	authConfig?: AuthConfig;
	github?: GitHubService | null;
}) {
	const authConfig: AuthConfig = overrides?.authConfig ?? {
		mode: "dev",
		token: "valid-token",
		userLogin: validCaller.login,
		orgLogin: validCaller.orgSlug,
	};

	return createWebApp({
		auth: overrides?.auth ?? mockAuthService(),
		authConfig,
		audit: {} as AuditService,
		db: {} as Database,
		dbUrl: "postgres://test:test@localhost:5432/test",
		stacks: {} as StacksService,
		updates: {} as UpdatesService,
		webhooks: {} as WebhooksService,
		esc: {} as EscService,
		github: overrides?.github ?? null,
		issueSubscriptionTicket:
			overrides?.issueSubscriptionTicket ??
			((caller: Caller) => subscriptionTickets.issueTicket(caller)),
		verifySubscriptionTicket:
			overrides?.verifySubscriptionTicket ??
			((ticket: string) => subscriptionTickets.verifyTicket(ticket)),
	});
}

describe("createWebApp tRPC auth", () => {
	test("subscriptions.createTicket requires authenticated caller", async () => {
		const app = makeApp();
		const res = await app.request("/trpc/subscriptions.createTicket?batch=1", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});

		expect(res.status).toBe(401);
	});

	test("rejects unauthorized compressed requests before inflation", async () => {
		const app = makeApp();
		const res = await app.request("/trpc/subscriptions.createTicket?batch=1", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: new Uint8Array([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff]),
		});

		expect(res.status).toBe(401);
	});

	test("inflates authenticated compressed requests", async () => {
		const app = makeApp();
		const res = await app.request("/trpc/subscriptions.createTicket?batch=1", {
			method: "POST",
			headers: {
				Authorization: "token valid-token",
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
			},
			body: gzipSync(Buffer.from("{}")),
		});

		expect(res.status).toBe(200);
	});

	test("subscriptions.createTicket returns a signed short-lived ticket", async () => {
		const app = makeApp();
		const res = await app.request("/trpc/subscriptions.createTicket?batch=1", {
			method: "POST",
			headers: {
				Authorization: "token valid-token",
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const body = (await res.json()) as Array<{
			result?: { data?: { json?: { ticket?: string } } };
		}>;

		expect(res.status).toBe(200);
		expect(typeof body[0]?.result?.data?.json?.ticket).toBe("string");
	});

	test("preserves the auth service receiver when creating CLI access keys", async () => {
		const auth = mockAuthService();
		auth.createCliAccessKey = async function (this: AuthService) {
			if (this !== auth) throw new Error("unbound auth service");
			return "bound-cli-token";
		};
		const app = makeApp({ auth });
		const res = await app.request("/api/auth/cli-token", {
			method: "POST",
			headers: {
				Authorization: "token valid-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "receiver-test" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: "bound-cli-token" });
	});

	test("GitHub setup sets a browser nonce for header and cookie authentication", async () => {
		const authenticationHeaders: Array<Record<string, string>> = [
			{ Authorization: "token valid-token" },
			{ Cookie: "DS=session-cookie" },
		];
		for (const headers of authenticationHeaders) {
			const github = mockGitHubService();
			const app = makeApp({ github });
			const res = await app.request("https://app.procella.test/trpc/github.createInstallationUrl", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ json: { accountLogin: "acme" } }),
			});

			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-store");
			const cookie = res.headers.get("set-cookie") ?? "";
			expect(cookie).toContain(`${GITHUB_SETUP_COOKIE_NAME}=`);
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("SameSite=Lax");
			expect(cookie).toContain("Secure");
			const nonce = cookie.match(new RegExp(`${GITHUB_SETUP_COOKIE_NAME}=([^;]+)`))?.[1];
			expect(nonce).toMatch(/^[a-zA-Z0-9_-]{43}$/);
			expect(github.issueInstallationUrl).toHaveBeenCalledWith(
				validCaller.tenantId,
				"acme",
				validCaller.userId,
				nonce,
			);
		}
	});

	test("SSE endpoint rejects wrong-signature tickets", async () => {
		const app = makeApp();
		const badTicket = await createSubscriptionTicketService(
			"wrong-ticket-signing-key-wrong-key",
		).issueTicket(validCaller);
		const res = await app.request(
			`/trpc/updates.onEvents?ticket=${encodeURIComponent(badTicket)}&input=%7B%22org%22%3A%22my-org%22%2C%22project%22%3A%22myproj%22%2C%22stack%22%3A%22dev%22%2C%22updateId%22%3A%22upd-1%22%7D`,
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ code: "invalid_ticket" });
	});
});

describe("createWebApp GitHub setup callback", () => {
	test("serves the public callback outside the Pulumi API namespace", async () => {
		const app = makeApp();
		const callback = await app.request(
			"/github/setup?installation_id=123&setup_action=install&state=signed",
		);
		expect(callback.status).toBe(303);
		expect(callback.headers.get("location")).toContain("reason=not_configured");

		const oauthCallback = await app.request("/github/oauth/callback?code=code&state=signed");
		expect(oauthCallback.status).toBe(303);
		expect(oauthCallback.headers.get("location")).toContain("reason=not_configured");

		const sacredApiPath = await app.request(
			"/api/github/setup?installation_id=123&setup_action=install&state=signed",
		);
		expect(sacredApiPath.status).toBe(404);
	});
});

describe("createWebApp auth config discovery", () => {
	test("GET /api/auth/config returns descope config with authBaseUrl when configured", async () => {
		const app = makeApp({
			authConfig: {
				mode: "descope",
				projectId: "P3web123",
				authBaseUrl: "https://auth.procella.cloud",
			},
		});
		const res = await app.request("/api/auth/config");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			mode: "descope",
			projectId: "P3web123",
			authBaseUrl: "https://auth.procella.cloud",
		});
	});

	test("GET /api/auth/config omits authBaseUrl when no custom auth domain is set", async () => {
		const app = makeApp({ authConfig: { mode: "descope", projectId: "P3web123" } });
		const res = await app.request("/api/auth/config");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mode: "descope", projectId: "P3web123" });
	});
});
