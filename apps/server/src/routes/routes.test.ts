import { describe, expect, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { UnauthorizedError } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { CreateWebhookInput, WebhookEventValue, WebhooksService } from "@procella/webhooks";
import { createApp } from "./index.js";

// ============================================================================
// Mock Data
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
	orgSlug: "my-org",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
};

const mockStackInfo: StackInfo = {
	id: "stack-uuid-1",
	projectId: "proj-uuid-1",
	tenantId: "t-1",
	orgName: "myorg",
	projectName: "myproj",
	stackName: "dev",
	tags: {},
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

// ============================================================================
// Mock Services
// ============================================================================

function mockAuthService(): AuthService {
	return {
		authenticate: async (request: Request) => {
			const header = request.headers.get("Authorization");
			if (!header || !header.startsWith("token ")) {
				throw new UnauthorizedError("Missing or invalid Authorization header");
			}
			const token = header.slice("token ".length);
			if (token !== "valid-token") {
				throw new UnauthorizedError("Invalid token");
			}
			return validCaller;
		},
		authenticateUpdateToken: async (token: string) => {
			const parts = token.split(":");
			if (parts.length !== 3 || parts[0] !== "update") {
				throw new UnauthorizedError("Invalid update token");
			}
			return { updateId: parts[1], stackId: parts[2] };
		},
	};
}

function mockStacksService(): StacksService {
	return {
		createStack: async () => mockStackInfo,
		getStack: async () => mockStackInfo,
		listStacks: async () => [mockStackInfo],
		deleteStack: async () => {},
		renameStack: async () => {},
		updateStackTags: async () => {},
		replaceStackTags: async () => {},
		getStackByFQN: async () => mockStackInfo,
	};
}

function mockUpdatesService(): UpdatesService {
	return {
		createUpdate: async () => ({ updateID: "upd-1" }),
		startUpdate: async () => ({
			version: 1,
			token: "lease-token",
			tokenExpiration: Date.now() + 300_000,
		}),
		completeUpdate: async () => {},
		cancelUpdate: async () => {},
		patchCheckpoint: async () => {},
		patchCheckpointVerbatim: async () => {},
		patchCheckpointDelta: async () => {},
		postEvents: async () => {},
		renewLease: async () => ({ token: "new-token" }),
		getUpdate: async () => ({
			status: "succeeded",
			events: [],
			startTime: Date.now(),
		}),
		getUpdateEvents: async () => ({ events: [] }),
		getHistory: async () => ({ updates: [] }),
		exportStack: async () => ({ version: 3, deployment: {} }),
		importStack: async () => ({ updateId: "imp-1" }),
		encryptValue: async () => new Uint8Array([1, 2, 3]),
		decryptValue: async () => new Uint8Array([4, 5, 6]),
		batchEncrypt: async () => [new Uint8Array([1])],
		batchDecrypt: async () => [new Uint8Array([2])],
	} as unknown as UpdatesService;
}

function mockAuditService(): AuditService {
	return {
		log: () => {},
		query: async () => ({ entries: [], total: 0 }),
		export: async () => [],
	};
}

function mockWebhooksService(): WebhooksService {
	return {
		createWebhook: async (_tenantId: string, input: CreateWebhookInput, createdBy: string) => ({
			id: "hook-1",
			name: input.name,
			url: input.url,
			events: input.events,
			active: true,
			createdBy,
			createdAt: new Date("2025-01-01"),
			updatedAt: new Date("2025-01-01"),
			secret: input.secret ?? "generated-secret",
		}),
		listWebhooks: async () => [],
		getWebhook: async () => null,
		updateWebhook: async (
			_tenantId: string,
			webhookId: string,
			updates: Partial<CreateWebhookInput>,
		) => ({
			id: webhookId,
			name: updates.name ?? "hook",
			url: updates.url ?? "https://example.com/hook",
			events: updates.events ?? ["stack.created"],
			active: true,
			createdBy: "u-1",
			createdAt: new Date("2025-01-01"),
			updatedAt: new Date("2025-01-01"),
		}),
		deleteWebhook: async () => {},
		listDeliveries: async (_tenantId: string, _webhookId: string, _limit?: number) => [],
		emit: (_event: {
			tenantId: string;
			event: WebhookEventValue;
			data: Record<string, unknown>;
		}) => {},
		ping: async () => ({
			id: "delivery-1",
			event: "webhook.ping",
			responseStatus: 200,
			success: true,
			attempt: 1,
			error: null,
			duration: 10,
			createdAt: new Date("2025-01-01"),
		}),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server routes", () => {
	function makeApp(
		authConfig: import("@procella/auth").AuthConfig = {
			mode: "dev",
			token: "valid-token",
			userLogin: "test-user",
			orgLogin: "test-org",
		},
	) {
		return createApp({
			auth: mockAuthService(),
			authConfig,
			audit: mockAuditService(),
			db: { execute: async () => ({ rows: [{ acquired: false }] }) } as unknown as Database,
			dbUrl: "postgres://test:test@localhost:5432/test",
			github: null,
			githubWebhookSecret: undefined,
			stacks: mockStacksService(),
			updates: mockUpdatesService(),
			webhooks: mockWebhooksService(),
		});
	}

	const authHeaders = {
		Authorization: "token valid-token",
		Accept: "application/vnd.pulumi+8",
	};

	// ========================================================================
	// Public routes (no auth required)
	// ========================================================================

	describe("public routes", () => {
		test("GET /healthz returns 200 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/healthz");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.status).toBe("ok");
		});

		test("GET /api/capabilities returns 200 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/capabilities");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.capabilities).toBeArray();
		});

		test("GET /api/cli/version returns 200 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/cli/version");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("latestVersion");
		});

		test("GET /api/auth/config returns dev mode config", async () => {
			const app = makeApp();
			const res = await app.request("/api/auth/config");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ mode: "dev" });
		});

		test("GET /api/auth/config returns descope mode config with projectId", async () => {
			const app = makeApp({ mode: "descope", projectId: "P3test123" });
			const res = await app.request("/api/auth/config");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ mode: "descope", projectId: "P3test123" });
		});
	});

	// ========================================================================
	// Cron GC endpoint
	// ========================================================================

	describe("GET /cron/gc", () => {
		test("returns 500 when CRON_SECRET missing in production", async () => {
			const prev = { secret: process.env.CRON_SECRET, env: process.env.NODE_ENV };
			delete process.env.CRON_SECRET;
			process.env.NODE_ENV = "production";
			try {
				const app = makeApp();
				const res = await app.request("/cron/gc");
				expect(res.status).toBe(500);
				const body = await res.json();
				expect(body.error).toContain("CRON_SECRET");
			} finally {
				process.env.CRON_SECRET = prev.secret;
				process.env.NODE_ENV = prev.env;
			}
		});

		test("returns 200 when CRON_SECRET missing in test env", async () => {
			const prev = { secret: process.env.CRON_SECRET, env: process.env.NODE_ENV };
			delete process.env.CRON_SECRET;
			process.env.NODE_ENV = "test";
			try {
				const app = makeApp();
				const res = await app.request("/cron/gc");
				expect(res.status).toBe(200);
			} finally {
				process.env.CRON_SECRET = prev.secret;
				process.env.NODE_ENV = prev.env;
			}
		});

		test("returns 401 with wrong Bearer token", async () => {
			const prev = process.env.CRON_SECRET;
			process.env.CRON_SECRET = "correct-secret";
			try {
				const app = makeApp();
				const res = await app.request("/cron/gc", {
					headers: { Authorization: "Bearer wrong-secret" },
				});
				expect(res.status).toBe(401);
			} finally {
				process.env.CRON_SECRET = prev;
			}
		});

		test("returns 200 with correct Bearer token", async () => {
			const prev = process.env.CRON_SECRET;
			process.env.CRON_SECRET = "correct-secret";
			try {
				const app = makeApp();
				const res = await app.request("/cron/gc", {
					headers: { Authorization: "Bearer correct-secret" },
				});
				expect(res.status).toBe(200);
			} finally {
				process.env.CRON_SECRET = prev;
			}
		});
	});

	// ========================================================================
	// Auth enforcement
	// ========================================================================

	describe("auth enforcement", () => {
		test("GET /api/user returns 401 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/user", {
				headers: { Accept: "application/vnd.pulumi+8" },
			});
			expect(res.status).toBe(401);
		});

		test("GET /api/stacks returns 401 without auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks", {
				headers: { Accept: "application/vnd.pulumi+8" },
			});
			expect(res.status).toBe(401);
		});
	});

	// ========================================================================
	// PulumiAccept enforcement
	// ========================================================================

	describe("PulumiAccept enforcement", () => {
		test("GET /api/user with valid auth but no Accept header returns 415", async () => {
			const app = makeApp();
			const res = await app.request("/api/user", {
				headers: { Authorization: "token valid-token" },
			});
			expect(res.status).toBe(415);
		});
	});

	// ========================================================================
	// Authenticated API routes
	// ========================================================================

	describe("authenticated API routes", () => {
		test("GET /api/user returns user info with valid auth", async () => {
			const app = makeApp();
			const res = await app.request("/api/user", { headers: authHeaders });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe("test-user");
		});

		test("GET /api/stacks returns stack list", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks", { headers: authHeaders });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
		});

		test("POST /api/stacks/:org/:project/:stack creates a stack", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev", {
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.orgName).toBe("my-org");
		});

		test("GET /api/stacks/:org/:project/:stack returns stack info", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev", {
				headers: authHeaders,
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stackName).toBe("dev");
		});

		test("DELETE /api/stacks/:org/:project/:stack returns 204", async () => {
			const app = makeApp();
			const res = await app.request("/api/stacks/myorg/myproj/dev", {
				method: "DELETE",
				headers: authHeaders,
			});
			expect(res.status).toBe(204);
		});
	});
});
