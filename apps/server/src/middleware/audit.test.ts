import { describe, expect, mock, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { auditMiddleware } from "./audit.js";

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

// ============================================================================
// Mock Services
// ============================================================================

function mockAuditService(): AuditService & { log: ReturnType<typeof mock> } {
	return {
		log: mock(() => {}),
		query: mock(async () => ({ entries: [], total: 0 })),
		export: mock(async () => []),
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

describe("auditMiddleware", () => {
	test("does NOT log GET requests", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.get("/api/stacks", (c) => c.json({ stacks: [] }));

		await app.request("/api/stacks");
		expect(audit.log).not.toHaveBeenCalled();
	});

	test("does NOT log HEAD requests", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.on("HEAD", "/api/stacks", (c) => c.body(null, 200));

		await app.request("/api/stacks", { method: "HEAD" });
		expect(audit.log).not.toHaveBeenCalled();
	});

	test("does NOT log requests with error status (>= 400)", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/org/proj/stack", (c) => c.json({ error: "bad" }, 400));

		await app.request("/api/stacks/org/proj/stack", { method: "POST" });
		expect(audit.log).not.toHaveBeenCalled();
	});

	test("logs POST mutations on success", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "stack-1" }));

		await app.request("/api/stacks/myorg/myproj/dev", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(audit.log).toHaveBeenCalledTimes(1);
		const callArgs = audit.log.mock.calls[0];
		expect(callArgs[0]).toBe("t-1");
	});

	test("logs DELETE mutations on success", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.delete("/api/stacks/:org/:project/:stack", (c) => c.body(null, 204));

		await app.request("/api/stacks/myorg/myproj/dev", { method: "DELETE" });
		expect(audit.log).toHaveBeenCalledTimes(1);
	});

	test("does NOT log when caller is not set", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		// No injectCaller middleware
		app.use("*", auditMiddleware(audit));
		app.post("/api/test", (c) => c.json({ ok: true }));

		await app.request("/api/test", { method: "POST" });
		expect(audit.log).not.toHaveBeenCalled();
	});

	test("includes IP and user-agent headers in log entry", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

		await app.request("/api/stacks/myorg/myproj/dev", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Forwarded-For": "1.2.3.4",
				"User-Agent": "pulumi-cli/3.100",
			},
			body: JSON.stringify({}),
		});
		expect(audit.log).toHaveBeenCalledTimes(1);
		const entry = audit.log.mock.calls[0][1];
		expect(entry.ipAddress).toBe("1.2.3.4");
		expect(entry.userAgent).toBe("pulumi-cli/3.100");
	});

	test("identifies token-based actors", async () => {
		const tokenCaller: Caller = {
			...validCaller,
			userId: "token:ak-12345",
		};
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(tokenCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

		await app.request("/api/stacks/myorg/myproj/dev", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const entry = audit.log.mock.calls[0][1];
		expect(entry.actorType).toBe("token");
	});
});
