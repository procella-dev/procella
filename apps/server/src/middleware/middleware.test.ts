import { describe, expect, test } from "bun:test";
import type { AuthService } from "@procella/auth";
import type { Caller } from "@procella/types";
import { StackNotFoundError, UnauthorizedError } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { apiAuth, updateAuth } from "./auth.js";
import { errorHandler } from "./error-handler.js";
import { requestLogger } from "./logging.js";
import { pulumiAccept } from "./pulumi-accept.js";

// ============================================================================
// Mock AuthService
// ============================================================================

const validCaller: Caller = {
	tenantId: "t-1",
	userId: "u-1",
	login: "test-user",
	roles: ["admin"],
};

function mockAuthService(opts?: { failAuth?: boolean }): AuthService {
	return {
		authenticate: async () => {
			if (opts?.failAuth) {
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

// ============================================================================
// Tests
// ============================================================================

describe("@procella/server middleware", () => {
	// ========================================================================
	// apiAuth
	// ========================================================================

	describe("apiAuth", () => {
		test("sets caller on context for valid token", async () => {
			const app = new Hono<Env>();
			app.use("*", apiAuth(mockAuthService()));
			app.get("/test", (c) => c.json(c.get("caller")));

			const res = await app.request("/test", {
				headers: { Authorization: "token valid-token" },
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.login).toBe("test-user");
		});

		test("returns 401 for invalid token", async () => {
			const app = new Hono<Env>();
			app.use("*", apiAuth(mockAuthService({ failAuth: true })));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "token bad" },
			});
			expect(res.status).toBe(401);
		});

		test("returns 401 for missing Authorization header", async () => {
			const app = new Hono<Env>();
			app.use("*", apiAuth(mockAuthService({ failAuth: true })));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(401);
		});
	});

	// ========================================================================
	// updateAuth
	// ========================================================================

	describe("updateAuth", () => {
		test("sets updateContext for valid update-token", async () => {
			const app = new Hono<Env>();
			app.use("*", updateAuth(mockAuthService()));
			app.get("/test", (c) => c.json(c.get("updateContext")));

			const res = await app.request("/test", {
				headers: { Authorization: "update-token update:uid-1:sid-1" },
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.updateId).toBe("uid-1");
			expect(body.stackId).toBe("sid-1");
		});

		test("returns 401 for missing update-token", async () => {
			const app = new Hono<Env>();
			app.use("*", updateAuth(mockAuthService()));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(401);
		});

		test("returns 401 for malformed token", async () => {
			const app = new Hono<Env>();
			app.use("*", updateAuth(mockAuthService()));
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Authorization: "update-token bad-format" },
			});
			expect(res.status).toBe(401);
		});
	});

	// ========================================================================
	// pulumiAccept
	// ========================================================================

	describe("pulumiAccept", () => {
		test("allows request with correct Accept header", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8" },
			});
			expect(res.status).toBe(200);
		});

		test("rejects request without Accept header", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(415);
		});

		test("allows Accept header with additional types", async () => {
			const app = new Hono();
			app.use("*", pulumiAccept());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test", {
				headers: { Accept: "application/vnd.pulumi+8, application/json" },
			});
			expect(res.status).toBe(200);
		});
	});

	// ========================================================================
	// errorHandler (uses app.onError)
	// ========================================================================

	describe("errorHandler", () => {
		test("maps ProcellaError to correct status code", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw new StackNotFoundError("org", "proj", "dev");
			});

			const res = await app.request("/test");
			expect(res.status).toBe(404);
			const body = await res.json();
			expect(body.code).toBe(404);
			expect(body.message).toContain("not found");
		});

		test("maps unknown error to 500", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw new Error("unexpected");
			});

			const res = await app.request("/test");
			expect(res.status).toBe(500);
			const body = await res.json();
			expect(body.code).toBe(500);
			expect(body.message).toBe("Internal server error");
		});

		test("returns ErrorResponse shape", async () => {
			const app = new Hono();
			app.onError(errorHandler());
			app.get("/test", () => {
				throw new UnauthorizedError("bad creds");
			});

			const res = await app.request("/test");
			const body = await res.json();
			expect(body).toHaveProperty("code");
			expect(body).toHaveProperty("message");
		});
	});

	// ========================================================================
	// requestLogger
	// ========================================================================

	describe("requestLogger", () => {
		test("calls next and does not block", async () => {
			const app = new Hono();
			app.use("*", requestLogger());
			app.get("/test", (c) => c.json({ ok: true }));

			const res = await app.request("/test");
			expect(res.status).toBe(200);
		});
	});
});
