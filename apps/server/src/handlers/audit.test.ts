import { describe, expect, mock, test } from "bun:test";
import type { AuditService } from "@procella/audit";
import type { Caller } from "@procella/types";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { auditHandlers } from "./audit.js";

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

const mockAuditEntry = {
	id: "entry-1",
	actorId: "u-1",
	actorType: "user" as const,
	action: "stack.create" as const,
	resourceType: "stack",
	resourceId: "stack-1",
	createdAt: new Date("2025-06-01"),
};

// ============================================================================
// Mock Services
// ============================================================================

function mockAuditService(overrides?: Partial<AuditService>): AuditService {
	return {
		log: mock(() => {}),
		query: mock(async () => ({ entries: [mockAuditEntry], total: 1 })) as AuditService["query"],
		export: mock(async () => [mockAuditEntry]) as AuditService["export"],
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

describe("auditHandlers", () => {
	describe("queryAuditLogs", () => {
		test("returns audit entries for caller org", async () => {
			const audit = mockAuditService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = auditHandlers({ audit });
			app.get("/orgs/:org/auditlogs", h.queryAuditLogs);

			const res = await app.request("/orgs/my-org/auditlogs");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.entries).toBeArray();
			expect(body.total).toBe(1);
		});

		test("passes query params to service", async () => {
			const queryFn = mock(async () => ({ entries: [], total: 0 }));
			const audit = mockAuditService({ query: queryFn });
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = auditHandlers({ audit });
			app.get("/orgs/:org/auditlogs", h.queryAuditLogs);

			await app.request("/orgs/my-org/auditlogs?page=2&pageSize=10&action=stack.create");
			expect(queryFn).toHaveBeenCalledTimes(1);
			const callArgs = (queryFn as ReturnType<typeof mock>).mock.calls[0] as unknown[];
			expect(callArgs[0]).toBe("t-1");
			expect(callArgs[1]).toMatchObject({ page: 2, pageSize: 10, action: "stack.create" });
		});

		test("returns 400 when org does not match caller", async () => {
			const audit = mockAuditService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = auditHandlers({ audit });
			app.get("/orgs/:org/auditlogs", h.queryAuditLogs);

			const res = await app.request("/orgs/wrong-org/auditlogs");
			expect(res.status).toBe(400);
		});
	});

	describe("exportAuditLogs", () => {
		test("returns exported entries for caller org", async () => {
			const audit = mockAuditService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = auditHandlers({ audit });
			app.get("/orgs/:org/auditlogs/export", h.exportAuditLogs);

			const res = await app.request("/orgs/my-org/auditlogs/export");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toBeArray();
			expect(body).toHaveLength(1);
		});

		test("returns 400 when org does not match caller", async () => {
			const audit = mockAuditService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = auditHandlers({ audit });
			app.get("/orgs/:org/auditlogs/export", h.exportAuditLogs);

			const res = await app.request("/orgs/wrong-org/auditlogs/export");
			expect(res.status).toBe(400);
		});

		test("passes date filters to service", async () => {
			const exportFn = mock(async () => []);
			const audit = mockAuditService({ export: exportFn });
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = auditHandlers({ audit });
			app.get("/orgs/:org/auditlogs/export", h.exportAuditLogs);

			await app.request("/orgs/my-org/auditlogs/export?startTime=2025-01-01&endTime=2025-12-31");
			expect(exportFn).toHaveBeenCalledTimes(1);
		});
	});
});
