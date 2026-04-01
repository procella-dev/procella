import { describe, expect, mock, test } from "bun:test";
import type { Caller } from "@procella/types";
import type { WebhooksService } from "@procella/webhooks";
import { Hono } from "hono";
import type { Env } from "../types.js";
import { webhookHandlers } from "./webhooks.js";

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

const mockWebhookInfo = {
	id: "hook-1",
	tenantId: "t-1",
	name: "Deploy Notifier",
	url: "https://example.com/hook",
	events: ["stack.update.succeeded"],
	active: true,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
	createdBy: "u-1",
};

const mockDelivery = {
	id: "delivery-1",
	webhookId: "hook-1",
	event: "update.succeeded",
	url: "https://example.com/hook",
	responseStatus: 200,
	success: true,
	attempt: 1,
	error: null,
	duration: 123,
	createdAt: new Date("2025-06-01"),
};

// ============================================================================
// Mock Services
// ============================================================================

function mockWebhooksService(overrides?: Partial<WebhooksService>): WebhooksService {
	return {
		createWebhook: mock(async () => ({ ...mockWebhookInfo, secret: "whsec_test123" })),
		listWebhooks: mock(async () => [mockWebhookInfo]),
		getWebhook: mock(async () => mockWebhookInfo),
		updateWebhook: mock(async () => mockWebhookInfo),
		deleteWebhook: mock(async () => {}),
		listDeliveries: mock(async () => [mockDelivery]),
		emit: mock(() => {}),
		emitAndWait: mock(async () => {}),
		ping: mock(async () => mockDelivery),
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

describe("webhookHandlers", () => {
	describe("createWebhook", () => {
		test("returns 201 with webhook including secret", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.post("/orgs/:org/hooks", h.createWebhook);

			const res = await app.request("/orgs/my-org/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "My Hook",
					url: "https://example.com/hook",
					events: ["stack.update.succeeded"],
				}),
			});
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.secret).toBe("whsec_test123");
			expect(body.name).toBe("Deploy Notifier");
		});

		test("returns error for wrong org", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.onError((err, c) => c.json({ error: (err as Error).message }, 400));
			const h = webhookHandlers({ webhooks });
			app.post("/orgs/:org/hooks", h.createWebhook);

			const res = await app.request("/orgs/wrong-org/hooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Hook",
					url: "https://example.com",
					events: ["stack.create"],
				}),
			});
			expect(res.status).toBe(400);
		});
	});

	describe("listWebhooks", () => {
		test("returns array of webhooks", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.get("/orgs/:org/hooks", h.listWebhooks);

			const res = await app.request("/orgs/my-org/hooks");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.webhooks).toBeArray();
			expect(body.webhooks).toHaveLength(1);
		});
	});

	describe("getWebhook", () => {
		test("returns webhook by id", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.get("/orgs/:org/hooks/:hookId", h.getWebhook);

			const res = await app.request("/orgs/my-org/hooks/hook-1");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.id).toBe("hook-1");
		});

		test("returns 404 when webhook not found", async () => {
			const webhooks = mockWebhooksService({
				getWebhook: mock(async () => null),
			});
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			app.onError((err, c) => c.json({ error: (err as Error).message }, 404));
			const h = webhookHandlers({ webhooks });
			app.get("/orgs/:org/hooks/:hookId", h.getWebhook);

			const res = await app.request("/orgs/my-org/hooks/missing");
			expect(res.status).toBe(404);
		});
	});

	describe("updateWebhook", () => {
		test("returns updated webhook", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.put("/orgs/:org/hooks/:hookId", h.updateWebhook);

			const res = await app.request("/orgs/my-org/hooks/hook-1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Updated Hook" }),
			});
			expect(res.status).toBe(200);
		});
	});

	describe("deleteWebhook", () => {
		test("returns 204", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.delete("/orgs/:org/hooks/:hookId", h.deleteWebhook);

			const res = await app.request("/orgs/my-org/hooks/hook-1", { method: "DELETE" });
			expect(res.status).toBe(204);
		});
	});

	describe("listDeliveries", () => {
		test("returns deliveries with default limit", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.get("/orgs/:org/hooks/:hookId/deliveries", h.listDeliveries);

			const res = await app.request("/orgs/my-org/hooks/hook-1/deliveries");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.deliveries).toBeArray();
		});

		test("respects limit param clamped to 200", async () => {
			const listFn = mock(async () => []);
			const webhooks = mockWebhooksService({ listDeliveries: listFn });
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.get("/orgs/:org/hooks/:hookId/deliveries", h.listDeliveries);

			await app.request("/orgs/my-org/hooks/hook-1/deliveries?limit=999");
			expect((listFn as ReturnType<typeof mock>).mock.calls[0]?.[2]).toBe(200);
		});
	});

	describe("ping", () => {
		test("returns delivery result", async () => {
			const webhooks = mockWebhooksService();
			const app = new Hono<Env>();
			app.use("*", injectCaller(validCaller));
			const h = webhookHandlers({ webhooks });
			app.post("/orgs/:org/hooks/:hookId/ping", h.ping);

			const res = await app.request("/orgs/my-org/hooks/hook-1/ping", { method: "POST" });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.success).toBe(true);
		});
	});
});
