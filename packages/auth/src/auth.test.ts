import { describe, expect, test } from "bun:test";
import { ForbiddenError, UnauthorizedError } from "@procella/types";
import {
	type AuthService,
	createAuthService,
	DescopeAuthService,
	DevAuthService,
	METHOD_ROLE_MAP,
	requireRole,
	slugify,
} from "./index.js";

// ============================================================================
// Helpers
// ============================================================================

const DEV_CONFIG = {
	token: "devtoken123",
	userLogin: "dev-user",
	orgLogin: "dev-org",
} as const;

/** Create a Request with a given Authorization header value. */
function reqWithAuth(authHeader: string): Request {
	return new Request("http://localhost:9090/api/test", {
		headers: { Authorization: authHeader },
	});
}

/** Create a Request with no Authorization header. */
function reqWithoutAuth(): Request {
	return new Request("http://localhost:9090/api/test");
}

// ============================================================================
// DevAuthService
// ============================================================================

describe("DevAuthService", () => {
	const svc = new DevAuthService(DEV_CONFIG);

	test("valid 'Authorization: token <value>' returns Caller", async () => {
		const caller = await svc.authenticate(reqWithAuth("token devtoken123"));

		expect(caller).toBeDefined();
		expect(caller.login).toBe("dev-user");
	});

	test("valid 'Authorization: Bearer <value>' returns Caller", async () => {
		const caller = await svc.authenticate(reqWithAuth("Bearer devtoken123"));

		expect(caller).toBeDefined();
		expect(caller.login).toBe("dev-user");
	});

	test("missing Authorization header throws UnauthorizedError", async () => {
		await expect(svc.authenticate(reqWithoutAuth())).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test("wrong token throws UnauthorizedError", async () => {
		await expect(svc.authenticate(reqWithAuth("token wrong-token"))).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
	});

	test("invalid Authorization format throws UnauthorizedError", async () => {
		await expect(svc.authenticate(reqWithAuth("Basic dXNlcjpwYXNz"))).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
	});

	test("returned Caller has correct tenantId, orgSlug, userId, login, roles", async () => {
		const caller = await svc.authenticate(reqWithAuth("token devtoken123"));

		expect(caller.tenantId).toBe("dev-org");
		expect(caller.orgSlug).toBe("dev-org");
		expect(caller.userId).toBe("dev-user");
		expect(caller.login).toBe("dev-user");
		expect(caller.roles).toEqual(["admin"]);
	});

	test("authenticateUpdateToken parses valid format", async () => {
		const result = await svc.authenticateUpdateToken("update:abc-123:stack-456");

		expect(result.updateId).toBe("abc-123");
		expect(result.stackId).toBe("stack-456");
	});

	test("authenticateUpdateToken rejects invalid format — missing prefix", async () => {
		await expect(svc.authenticateUpdateToken("abc-123:stack-456")).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
	});

	test("authenticateUpdateToken rejects invalid format — too few parts", async () => {
		await expect(svc.authenticateUpdateToken("update:abc-123")).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
	});

	test("authenticateUpdateToken rejects empty segments", async () => {
		await expect(svc.authenticateUpdateToken("update::stack-456")).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
	});
});

// ============================================================================
// DescopeAuthService — JWT guard
// ============================================================================

describe("DescopeAuthService", () => {
	// Uses a placeholder project ID — the JWT guard fires before any SDK call.
	const svc = new DescopeAuthService({ projectId: "P3Aaha02iJvkGVbPDAF78KWuAxe6" });

	test("rejects session JWT on 'token' prefix (CLI path)", async () => {
		// eyJhbGciOiJIUzI1NiJ9 is a valid JWT header prefix
		const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake";
		await expect(svc.authenticate(reqWithAuth(`token ${fakeJwt}`))).rejects.toBeInstanceOf(
			UnauthorizedError,
		);
	});

	test("rejection message mentions pulumi login", async () => {
		const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake";
		await expect(svc.authenticate(reqWithAuth(`token ${fakeJwt}`))).rejects.toThrow(/pulumi login/);
	});
});

// ============================================================================
// requireRole
// ============================================================================

describe("requireRole", () => {
	test("allows caller with matching role", () => {
		const caller = {
			tenantId: "t1",
			orgSlug: "t1",
			userId: "u1",
			login: "user",
			roles: ["member"] as const,
		};

		expect(() => requireRole(caller, "member")).not.toThrow();
	});

	test("admin caller passes any role check", () => {
		const caller = {
			tenantId: "t1",
			orgSlug: "t1",
			userId: "u1",
			login: "admin",
			roles: ["admin"] as const,
		};

		expect(() => requireRole(caller, "viewer")).not.toThrow();
		expect(() => requireRole(caller, "member")).not.toThrow();
		expect(() => requireRole(caller, "admin")).not.toThrow();
	});

	test("member caller passes member and viewer checks", () => {
		const caller = {
			tenantId: "t1",
			orgSlug: "t1",
			userId: "u1",
			login: "member",
			roles: ["member"] as const,
		};

		expect(() => requireRole(caller, "viewer")).not.toThrow();
		expect(() => requireRole(caller, "member")).not.toThrow();
	});

	test("throws ForbiddenError for caller without matching role", () => {
		const caller = {
			tenantId: "t1",
			orgSlug: "t1",
			userId: "u1",
			login: "viewer",
			roles: ["viewer"] as const,
		};

		expect(() => requireRole(caller, "admin")).toThrow(ForbiddenError);
	});

	test("viewer cannot perform member actions", () => {
		const caller = {
			tenantId: "t1",
			orgSlug: "t1",
			userId: "u1",
			login: "viewer",
			roles: ["viewer"] as const,
		};

		expect(() => requireRole(caller, "member")).toThrow(ForbiddenError);
	});
});

// ============================================================================
// METHOD_ROLE_MAP
// ============================================================================

describe("METHOD_ROLE_MAP", () => {
	test("all standard HTTP methods are mapped", () => {
		const expectedMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
		for (const method of expectedMethods) {
			expect(METHOD_ROLE_MAP[method]).toBeDefined();
		}
	});

	test("read methods map to viewer", () => {
		expect(METHOD_ROLE_MAP.GET).toBe("viewer");
		expect(METHOD_ROLE_MAP.HEAD).toBe("viewer");
	});

	test("write methods map to member", () => {
		expect(METHOD_ROLE_MAP.POST).toBe("member");
		expect(METHOD_ROLE_MAP.PUT).toBe("member");
		expect(METHOD_ROLE_MAP.PATCH).toBe("member");
	});

	test("DELETE maps to admin", () => {
		expect(METHOD_ROLE_MAP.DELETE).toBe("admin");
	});
});

// ============================================================================
// createAuthService factory
// ============================================================================

describe("createAuthService", () => {
	test("returns DevAuthService for mode 'dev'", () => {
		const svc = createAuthService({
			mode: "dev",
			token: "tok",
			userLogin: "u",
			orgLogin: "o",
		});

		expect(svc).toBeInstanceOf(DevAuthService);
	});

	test("returns DescopeAuthService for mode 'descope'", () => {
		const svc = createAuthService({
			mode: "descope",
			projectId: "P3Aaha02iJvkGVbPDAF78KWuAxe6",
		});

		expect(svc).toBeInstanceOf(DescopeAuthService);
	});

	test("factory returns object implementing AuthService interface", () => {
		const svc: AuthService = createAuthService({
			mode: "dev",
			token: "tok",
			userLogin: "u",
			orgLogin: "o",
		});

		expect(typeof svc.authenticate).toBe("function");
		expect(typeof svc.authenticateUpdateToken).toBe("function");
	});
});

// ============================================================================
// slugify
// ============================================================================

describe("slugify", () => {
	test("converts simple name to lowercase slug", () => {
		expect(slugify("My Company")).toBe("my-company");
	});

	test("replaces multiple non-alphanumeric chars with single hyphen", () => {
		expect(slugify("Hello   World!!!")).toBe("hello-world");
	});

	test("trims leading/trailing hyphens", () => {
		expect(slugify("--hello--")).toBe("hello");
	});

	test("handles already-valid slug", () => {
		expect(slugify("my-org")).toBe("my-org");
	});

	test("returns empty string for non-Latin-only input", () => {
		expect(slugify("日本語")).toBe("");
	});

	test("returns empty string for whitespace-only input", () => {
		expect(slugify("   ")).toBe("");
	});

	test("returns empty string for punctuation-only input", () => {
		expect(slugify("!@#$%")).toBe("");
	});

	test("handles mixed Latin and non-Latin", () => {
		expect(slugify("Acme Corp 株式会社")).toBe("acme-corp");
	});

	test("collapses consecutive hyphens from mixed separators", () => {
		expect(slugify("a - b _ c")).toBe("a-b-c");
	});
});
