import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Mock the logger before importing the module
mock.module("../logger.js", () => ({
	logger: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
	},
}));

const { requestLogger } = await import("./logging.js");
const { logger } = await import("../logger.js");

describe("requestLogger middleware", () => {
	function createApp(handlerStatus: number = 200) {
		const app = new Hono();
		app.use("*", requestLogger());
		app.get("/test", (c) => c.json({ ok: true }, handlerStatus as 200));
		app.post("/fail", (c) => c.json({ error: "bad" }, 400));
		app.get("/error", (c) => c.json({ error: "server" }, 500));
		return app;
	}

	test("logs info for 2xx responses", async () => {
		const app = createApp();
		await app.request("/test");
		expect(logger.info).toHaveBeenCalled();
	});

	test("logs warn for 4xx responses", async () => {
		const app = createApp();
		await app.request("/fail", { method: "POST" });
		expect(logger.warn).toHaveBeenCalled();
	});

	test("logs error for 5xx responses", async () => {
		const app = createApp();
		await app.request("/error");
		expect(logger.error).toHaveBeenCalled();
	});

	test("log data includes method, path, status, duration", async () => {
		const app = createApp();
		await app.request("/test");
		const calls = (logger.info as ReturnType<typeof mock>).mock.calls;
		const lastCall = calls[calls.length - 1];
		const data = lastCall[0] as { method: string; path: string; status: number; duration: number };
		expect(data.method).toBe("GET");
		expect(data.path).toBe("/test");
		expect(data.status).toBe(200);
		expect(typeof data.duration).toBe("number");
	});
});
