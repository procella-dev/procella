import { describe, expect, test } from "bun:test";
import type { AuthService } from "@strata/auth";
import type { Database } from "@strata/db";
import type { StackInfo, StacksService } from "@strata/stacks";
import type { Caller } from "@strata/types";
import { UnauthorizedError } from "@strata/types";
import type { UpdatesService } from "@strata/updates";
import { createApp } from "./index.js";

// ============================================================================
// Mock Data
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
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

// ============================================================================
// Tests
// ============================================================================

describe("@strata/server routes", () => {
	function makeApp(
		authConfig: import("@strata/auth").AuthConfig = {
			mode: "dev",
			token: "valid-token",
			userLogin: "test-user",
			orgLogin: "test-org",
		},
	) {
		return createApp({
			auth: mockAuthService(),
			authConfig,
			db: {} as Database,
			stacks: mockStacksService(),
			updates: mockUpdatesService(),
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
			expect(body.orgName).toBe("myorg");
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
