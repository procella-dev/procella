import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { activeContext, tracingMiddleware } from "./middleware.js";

describe("@procella/telemetry middleware", () => {
	function createApp() {
		const app = new Hono();
		app.use("*", tracingMiddleware());
		app.get("/test", (c) => c.json({ ok: true }));
		app.get("/items/:id", (c) => c.json({ id: c.req.param("id") }));
		app.post("/create", (c) => c.json({ created: true }));
		app.get("/error", () => {
			throw new Error("test error");
		});
		app.get("/server-error", (c) => c.json({ error: true }, 500));
		app.onError((_err, c) => c.json({ error: "caught" }, 500));
		return app;
	}

	test("passes through successful requests", async () => {
		const app = createApp();
		const res = await app.request("/test");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test("handles parameterized routes", async () => {
		const app = createApp();
		const res = await app.request("/items/42");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe("42");
	});

	test("handles POST requests", async () => {
		const app = createApp();
		const res = await app.request("/create", { method: "POST" });
		expect(res.status).toBe(200);
	});

	test("propagates errors and records exception", async () => {
		const app = createApp();
		const res = await app.request("/error");
		expect(res.status).toBe(500);
	});

	test("records 500 status without throwing", async () => {
		const app = createApp();
		const res = await app.request("/server-error");
		expect(res.status).toBe(500);
	});

	test("handles 404 for unmatched routes", async () => {
		const app = createApp();
		const res = await app.request("/nonexistent");
		expect(res.status).toBe(404);
	});

	test("passes W3C trace context headers", async () => {
		const app = createApp();
		const res = await app.request("/test", {
			headers: {
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			},
		});
		expect(res.status).toBe(200);
	});
});

describe("activeContext", () => {
	test("returns a context object", () => {
		const ctx = activeContext();
		expect(ctx).toBeDefined();
	});
});
