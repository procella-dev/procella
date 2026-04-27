import { describe, expect, mock, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { auditMiddleware } from "./audit.js";
import { INTERNAL_CLIENT_IP_HEADER } from "./security.js";

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

	test("includes direct client IP and user-agent headers in log entry", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

		await app.request("/api/stacks/myorg/myproj/dev", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[INTERNAL_CLIENT_IP_HEADER]: "10.20.30.40",
				"User-Agent": "pulumi-cli/3.100",
			},
			body: JSON.stringify({}),
		});
		expect(audit.log).toHaveBeenCalledTimes(1);
		const entry = audit.log.mock.calls[0][1];
		expect(entry.ipAddress).toBe("10.20.30.40");
		expect(entry.userAgent).toBe("pulumi-cli/3.100");
	});

	test("ignores X-Forwarded-For when PROCELLA_TRUST_PROXY is not true", async () => {
		const previousTrustProxy = process.env.PROCELLA_TRUST_PROXY;
		delete process.env.PROCELLA_TRUST_PROXY;

		try {
			const audit = mockAuditService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.use("*", auditMiddleware(audit));
			app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

			await app.request("/api/stacks/myorg/myproj/dev", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[INTERNAL_CLIENT_IP_HEADER]: "10.0.0.7",
					"X-Forwarded-For": "1.2.3.4, 5.6.7.8",
				},
				body: JSON.stringify({}),
			});

			expect(audit.log).toHaveBeenCalledTimes(1);
			expect(audit.log.mock.calls[0][1].ipAddress).toBe("10.0.0.7");
		} finally {
			if (previousTrustProxy === undefined) {
				delete process.env.PROCELLA_TRUST_PROXY;
			} else {
				process.env.PROCELLA_TRUST_PROXY = previousTrustProxy;
			}
		}
	});

	test("uses rightmost X-Forwarded-For value when PROCELLA_TRUST_PROXY is true (PR #149 review — leftmost is client-spoofable)", async () => {
		const previousTrustProxy = process.env.PROCELLA_TRUST_PROXY;
		process.env.PROCELLA_TRUST_PROXY = "true";

		try {
			const audit = mockAuditService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.use("*", auditMiddleware(audit));
			app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

			await app.request("/api/stacks/myorg/myproj/dev", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[INTERNAL_CLIENT_IP_HEADER]: "10.0.0.7",
					"X-Forwarded-For": "9.9.9.9, 5.6.7.8",
				},
				body: JSON.stringify({}),
			});

			expect(audit.log).toHaveBeenCalledTimes(1);
			expect(audit.log.mock.calls[0][1].ipAddress).toBe("5.6.7.8");
		} finally {
			if (previousTrustProxy === undefined) {
				delete process.env.PROCELLA_TRUST_PROXY;
			} else {
				process.env.PROCELLA_TRUST_PROXY = previousTrustProxy;
			}
		}
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

	test("identifies workload actors and includes workload metadata", async () => {
		const workloadCaller: Caller = {
			...validCaller,
			userId: "",
			login: "github-actions:acme/procella",
			principalType: "workload",
			workload: {
				provider: "github",
				issuer: "https://token.actions.githubusercontent.com",
				subject: "repo:acme/procella:ref:refs/heads/main",
				repository: "acme/procella",
			},
		};
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(workloadCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

		await app.request("/api/stacks/myorg/myproj/dev", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const entry = audit.log.mock.calls[0][1];
		expect(entry.actorType).toBe("workload");
		expect(entry.actorId).toBe("github-actions:acme/procella");
		expect(entry.metadata).toEqual({
			workload: {
				provider: "github",
				issuer: "https://token.actions.githubusercontent.com",
				subject: "repo:acme/procella:ref:refs/heads/main",
				repository: "acme/procella",
			},
		});
	});

	test("user actors have no workload metadata", async () => {
		const audit = mockAuditService();
		const app = new Hono<Env>();
		app.use("*", injectCaller(validCaller));
		app.use("*", auditMiddleware(audit));
		app.post("/api/stacks/:org/:project/:stack", (c) => c.json({ id: "s-1" }));

		await app.request("/api/stacks/myorg/myproj/dev", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const entry = audit.log.mock.calls[0][1];
		expect(entry.actorType).toBe("user");
		expect(entry.metadata).toBeUndefined();
	});
});
