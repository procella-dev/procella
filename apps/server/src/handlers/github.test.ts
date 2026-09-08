import { describe, expect, mock, test } from "bun:test";
import { GITHUB_SETUP_COOKIE_NAME, type GitHubService, GitHubSetupError } from "@procella/github";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { githubHandlers } from "./github.js";

// ============================================================================
// Mock Data
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
	principalType: "user",
};

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

const BROWSER_NONCE = "a".repeat(43);
const SETUP_COOKIE = `${GITHUB_SETUP_COOKIE_NAME}=${BROWSER_NONCE}`;

// ============================================================================
// Mock Services
// ============================================================================

function mockGitHubService(overrides?: Partial<GitHubService>): GitHubService {
	return {
		handleWebhookEvent: mock(async () => {}),
		connectAvailable: true,
		resolveConnectedLogin: mock(async () => "alice"),
		beginConnect: mock(async () => "signed-connect-state"),
		confirmConnect: mock(async () => ({ login: "alice" })),
		listConnectTargets: mock(async () => []),
		connectInstallation: mock(async () => mockInstallation),
		issueInstallationUrl: mock(async () => "https://github.com/apps/procella/installations/new"),
		completeInstallation: mock(async () => mockInstallation),
		listInstallations: mock(async () => [mockInstallation]),
		resolveInstallation: mock(async () => mockInstallation),
		createPRComment: mock(async () => 1),
		findPRComment: mock(async () => null),
		updatePRComment: mock(async () => {}),
		setCommitStatus: mock(async () => {}),
		removeInstallation: mock(async () => {}),
		...overrides,
	};
}

function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("githubHandlers", () => {
	describe("handleGitHubWebhook", () => {
		test("returns 200 when github is not configured", async () => {
			const app = new Hono<Env>();
			const h = githubHandlers({
				github: null,
				webhookSecret: undefined,
				verifySignature: mock(async () => true),
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "push",
					"X-Hub-Signature-256": "sha256=abc",
				},
				body: JSON.stringify({ action: "completed" }),
			});
			expect(res.status).toBe(200);
		});

		test("processes valid webhook event", async () => {
			const github = mockGitHubService();
			const verifySignature = mock(async () => true);
			const app = new Hono<Env>();
			const h = githubHandlers({
				github,
				webhookSecret: "secret",
				verifySignature,
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "installation",
					"X-Hub-Signature-256": `sha256=${"a".repeat(64)}`,
				},
				body: JSON.stringify({ action: "created" }),
			});
			expect(res.status).toBe(200);
			expect(github.handleWebhookEvent).toHaveBeenCalledTimes(1);
			expect(verifySignature).toHaveBeenCalledWith(
				new TextEncoder().encode(JSON.stringify({ action: "created" })),
				`sha256=${"a".repeat(64)}`,
				"secret",
			);
		});

		test("rejects missing and malformed signatures before reading the body", async () => {
			const verifySignature = mock(async () => false);
			const app = new Hono<Env>();
			const h = githubHandlers({
				github: mockGitHubService(),
				webhookSecret: "secret",
				verifySignature,
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			for (const signature of [undefined, "sha256=invalid"]) {
				const headers = new Headers({
					"Content-Type": "application/json",
					"X-GitHub-Event": "push",
				});
				if (signature) headers.set("X-Hub-Signature-256", signature);
				const request = new Request("http://localhost/webhooks/github", {
					method: "POST",
					headers,
					body: JSON.stringify({}),
				});
				let bodyRead = false;
				Object.defineProperty(request, "body", {
					get() {
						bodyRead = true;
						throw new Error("body must not be read");
					},
				});

				const res = await app.fetch(request);
				expect(res.status).toBe(401);
				expect(bodyRead).toBe(false);
			}
			expect(verifySignature).not.toHaveBeenCalled();
		});

		test("stops buffering webhooks at the raw byte limit", async () => {
			const verifySignature = mock(async () => true);
			const app = new Hono<Env>();
			const h = githubHandlers({
				github: mockGitHubService(),
				webhookSecret: "secret",
				verifySignature,
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			let chunksRead = 0;
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					chunksRead += 1;
					controller.enqueue(new Uint8Array(1024 * 1024));
					if (chunksRead === 30) controller.close();
				},
				cancel() {
					cancelled = true;
				},
			});
			const res = await app.fetch(
				new Request("http://localhost/webhooks/github", {
					method: "POST",
					headers: {
						"X-GitHub-Event": "push",
						"X-Hub-Signature-256": `sha256=${"a".repeat(64)}`,
					},
					body,
				}),
			);

			expect(res.status).toBe(413);
			expect(chunksRead).toBeLessThan(30);
			expect(cancelled).toBe(true);
			expect(verifySignature).not.toHaveBeenCalled();
		});

		test("returns error when X-GitHub-Event header missing", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = githubHandlers({
				github,
				webhookSecret: "secret",
				verifySignature: mock(async () => true),
			});
			app.post("/webhooks/github", h.handleGitHubWebhook);

			const res = await app.request("/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Hub-Signature-256": `sha256=${"a".repeat(64)}`,
				},
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("completeInstallation", () => {
		test("binds the installation in the initiating browser and clears its nonce", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			const res = await app.request(
				"/github/setup?installation_id=12345&setup_action=install&state=signed-state&account_login=attacker",
				{ headers: { Cookie: SETUP_COOKIE } },
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/settings?github=connected#github");
			expect(github.completeInstallation).toHaveBeenCalledWith(
				"signed-state",
				12345,
				BROWSER_NONCE,
			);
			const cookies = res.headers.getSetCookie();
			expect(cookies).toHaveLength(1);
			expect(cookies[0]).toContain(`${GITHUB_SETUP_COOKIE_NAME}=;`);
			expect(cookies[0]).toContain("Max-Age=0");
			expect(cookies[0]).toContain("; Secure;");
			expect(cookies[0]).toContain("Path=/");
			expect(cookies[0]).not.toContain("Domain=");
		});

		test("binds a pre-existing installation reported as setup_action=update", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			const res = await app.request(
				"/github/setup?installation_id=12345&setup_action=update&state=signed-state",
				{ headers: { Cookie: SETUP_COOKIE } },
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/settings?github=connected#github");
			expect(github.completeInstallation).toHaveBeenCalledWith(
				"signed-state",
				12345,
				BROWSER_NONCE,
			);
		});

		test("rejects missing or malformed callback parameters before persistence", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			for (const query of [
				"installation_id=123&setup_action=install",
				"installation_id=not-a-number&setup_action=install&state=state",
				`installation_id=123&setup_action=install&state=${"x".repeat(4097)}`,
			]) {
				const res = await app.request(`/github/setup?${query}`);
				expect(res.status).toBe(303);
				expect(res.headers.get("location")).toContain("reason=invalid_callback");
			}
			expect(github.completeInstallation).not.toHaveBeenCalled();
		});

		test("rejects an installation callback without the initiating browser cookie", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			const res = await app.request(
				"/github/setup?installation_id=123&setup_action=install&state=signed-state",
			);
			expect(res.headers.get("location")).toContain("reason=invalid_state");
			expect(github.completeInstallation).not.toHaveBeenCalled();
		});

		test("rejects unknown setup actions without touching state", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			const h = githubHandlers({ github, verifySignature: mock(async () => true) });
			app.get("/github/setup", h.completeInstallation);

			const res = await app.request(
				"/github/setup?installation_id=123&setup_action=request&state=signed-state",
				{ headers: { Cookie: SETUP_COOKIE } },
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toContain("reason=unsupported_setup_action");
			expect(github.completeInstallation).not.toHaveBeenCalled();
		});

		test("surfaces vaulted verification failures without persisting", async () => {
			for (const code of ["expired_state", "authorization_required"] as const) {
				const github = mockGitHubService({
					completeInstallation: mock(async () => {
						throw new GitHubSetupError(code);
					}),
				});
				const app = new Hono<Env>();
				const h = githubHandlers({ github, verifySignature: mock(async () => true) });
				app.get("/github/setup", h.completeInstallation);

				const res = await app.request(
					"/github/setup?installation_id=123&setup_action=install&state=signed",
					{ headers: { Cookie: SETUP_COOKIE } },
				);
				expect(res.status).toBe(303);
				expect(res.headers.get("location")).toContain(`reason=${code}`);
			}
		});
	});

	describe("getInstallation", () => {
		test("returns installation when configured", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github,
				verifySignature: mock(async () => true),
			});
			app.get("/orgs/:org/integrations/github", h.getInstallation);

			const res = await app.request("/orgs/my-org/integrations/github");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.installation.installationId).toBe(12345);
		});

		test("returns null installation when github not configured", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github: null,
				verifySignature: mock(async () => true),
			});
			app.get("/orgs/:org/integrations/github", h.getInstallation);

			const res = await app.request("/orgs/my-org/integrations/github");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.installation).toBeNull();
		});

		test("returns 400 for wrong org", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = githubHandlers({
				github: mockGitHubService(),
				verifySignature: mock(async () => true),
			});
			app.get("/orgs/:org/integrations/github", h.getInstallation);

			const res = await app.request("/orgs/wrong-org/integrations/github");
			expect(res.status).toBe(400);
		});
	});

	describe("removeInstallation", () => {
		test("returns 204 after removing installation", async () => {
			const github = mockGitHubService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github,
				verifySignature: mock(async () => true),
			});
			app.delete("/orgs/:org/integrations/github", h.removeInstallation);

			const res = await app.request("/orgs/my-org/integrations/github", { method: "DELETE" });
			expect(res.status).toBe(204);
			expect(github.removeInstallation).toHaveBeenCalledWith("t-1", 12345, "u-1");
		});

		test("returns 204 when no installation exists", async () => {
			const github = mockGitHubService({
				listInstallations: mock(async () => []),
			});
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github,
				verifySignature: mock(async () => true),
			});
			app.delete("/orgs/:org/integrations/github", h.removeInstallation);

			const res = await app.request("/orgs/my-org/integrations/github", { method: "DELETE" });
			expect(res.status).toBe(204);
			expect(github.removeInstallation).not.toHaveBeenCalled();
		});

		test("returns 204 when github not configured", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = githubHandlers({
				github: null,
				verifySignature: mock(async () => true),
			});
			app.delete("/orgs/:org/integrations/github", h.removeInstallation);

			const res = await app.request("/orgs/my-org/integrations/github", { method: "DELETE" });
			expect(res.status).toBe(204);
		});
	});
});
