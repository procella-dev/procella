import { describe, expect, test } from "bun:test";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import { BadRequestError } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { healthHandlers } from "./health.js";
import { param, updateContext } from "./params.js";
import { stackHandlers } from "./stacks.js";
import { userHandlers } from "./user.js";

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
	tags: { env: "dev" },
	activeUpdateId: null,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

// ============================================================================
// Mock Services
// ============================================================================

function mockStacksService(overrides?: Partial<StacksService>): StacksService {
	return {
		createStack: async () => mockStackInfo,
		getStack: async () => mockStackInfo,
		listStacks: async () => [mockStackInfo],
		deleteStack: async () => {},
		renameStack: async () => {},
		updateStackTags: async () => {},
		getStackByFQN: async () => mockStackInfo,
		...overrides,
	};
}

/** Middleware that injects a mock caller into context. */
function injectCaller(caller: Caller) {
	return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("caller", caller);
		await next();
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server handlers", () => {
	// ========================================================================
	// healthHandlers
	// ========================================================================

	describe("healthHandlers", () => {
		const mockDb = { execute: async () => [{ "?column?": 1 }] } as never;

		test("health returns { status: ok } when db is reachable", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb });
			app.get("/healthz", health.health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.status).toBe("ok");
		});

		test("health returns 503 when db is unreachable", async () => {
			const failDb = {
				execute: async () => {
					throw new Error("connection refused");
				},
			} as never;
			const app = new Hono<Env>();
			const health = healthHandlers({ db: failDb });
			app.get("/healthz", health.health);

			const res = await app.request("/healthz");
			expect(res.status).toBe(503);
			const body = await res.json();
			expect(body.status).toBe("error");
		});

		test("capabilities returns array with expected capabilities", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb });
			app.get("/capabilities", health.capabilities);

			const res = await app.request("/capabilities");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.capabilities).toBeArray();
			expect(body.capabilities).toHaveLength(4);

			const names = body.capabilities.map((c: { capability: string }) => c.capability);
			expect(names).toContain("delta-checkpoint-uploads-v2");
			expect(names).toContain("batch-encrypt");
			expect(names).toContain("deployment-schema-version");
			expect(names).toContain("journaling-v1");
		});

		test("cliVersion returns version info", async () => {
			const app = new Hono<Env>();
			const health = healthHandlers({ db: mockDb });
			app.get("/version", health.cliVersion);

			const res = await app.request("/version");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toHaveProperty("latestVersion");
			expect(body).toHaveProperty("oldestWithoutWarning");
			expect(body).toHaveProperty("latestDevVersion");
		});
	});

	// ========================================================================
	// param() helper
	// ========================================================================

	describe("param()", () => {
		test("returns param value when present", async () => {
			const app = new Hono<Env>();
			app.get("/test/:id", (c) => {
				const id = param(c, "id");
				return c.json({ id });
			});

			const res = await app.request("/test/abc");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.id).toBe("abc");
		});

		test("throws BadRequestError when param is missing", () => {
			// param() is a pure function that reads from context
			// Test by calling with a mock context that has no params
			const mockContext = {
				req: {
					param: (_name: string) => undefined,
				},
			};
			expect(() => param(mockContext as never, "missing")).toThrow(BadRequestError);
		});
	});

	// ========================================================================
	// updateContext() helper
	// ========================================================================

	describe("updateContext()", () => {
		test("returns updateContext when set", async () => {
			const app = new Hono<Env>();
			app.use("*", async (c, next) => {
				c.set("updateContext", { updateId: "u-1", stackId: "s-1" });
				await next();
			});
			app.get("/test", (c) => {
				const ctx = updateContext(c);
				return c.json(ctx);
			});

			const res = await app.request("/test");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.updateId).toBe("u-1");
			expect(body.stackId).toBe("s-1");
		});

		test("throws BadRequestError when updateContext is not set", () => {
			const mockContext = {
				get: (_key: string) => undefined,
			};
			expect(() => updateContext(mockContext as never)).toThrow(BadRequestError);
		});
	});

	// ========================================================================
	// userHandlers
	// ========================================================================

	describe("userHandlers", () => {
		test("getCurrentUser returns user info from caller", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user", user.getCurrentUser);

			const res = await app.request("/user");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe("test-user");
			expect(body.name).toBe("test-user");
			expect(body.organizations).toBeArray();
			expect(body.organizations[0].githubLogin).toBe("my-org");
		});

		test("getUserStacks returns stacks for caller tenant", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/stacks", user.getUserStacks);

			const res = await app.request("/stacks");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
			expect(body.stacks).toHaveLength(1);
		});
	});

	// ========================================================================
	// stackHandlers
	// ========================================================================

	describe("stackHandlers", () => {
		test("createStack returns mapped Stack shape", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.post("/stacks/:org/:project/:stack", stackH.createStack);

			const res = await app.request("/stacks/myorg/myproj/dev", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.orgName).toBe("my-org");
			expect(body.projectName).toBe("myproj");
			expect(body.stackName).toBe("dev");
			expect(body).toHaveProperty("id");
		});

		test("getStack returns mapped Stack shape", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.get("/stacks/:org/:project/:stack", stackH.getStack);

			const res = await app.request("/stacks/myorg/myproj/dev");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.orgName).toBe("my-org");
			expect(body.stackName).toBe("dev");
		});

		test("deleteStack returns 204", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.delete("/stacks/:org/:project/:stack", stackH.deleteStack);

			const res = await app.request("/stacks/myorg/myproj/dev", {
				method: "DELETE",
			});
			expect(res.status).toBe(204);
		});

		test("listStacks returns array of stacks", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.get("/stacks", stackH.listStacks);

			const res = await app.request("/stacks");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.stacks).toBeArray();
			expect(body.stacks).toHaveLength(1);
		});

		test("renameStack returns 204", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.post("/stacks/:org/:project/:stack/rename", stackH.renameStack);

			const res = await app.request("/stacks/myorg/myproj/dev/rename", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ newName: "staging" }),
			});
			expect(res.status).toBe(204);
		});

		test("updateStackTags returns 204", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const stackH = stackHandlers(mockStacksService());
			app.patch("/stacks/:org/:project/:stack/tags", stackH.updateStackTags);

			const res = await app.request("/stacks/myorg/myproj/dev/tags", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ env: "staging", team: "platform" }),
			});
			expect(res.status).toBe(204);
		});
	});

	// ========================================================================
	// userHandlers — additional
	// ========================================================================

	describe("userHandlers — getOrganization", () => {
		test("getOrganization returns org info with defaults", async () => {
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const user = userHandlers(mockStacksService());
			app.get("/user/organizations/:orgName", user.getOrganization);

			const res = await app.request("/user/organizations/my-org");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.githubLogin).toBe("my-org");
			expect(body.name).toBe("my-org");
			expect(body.defaultTeam).toBeDefined();
			expect(body.defaultTeam.name).toBe("my-org");
		});
	});
});
