import { describe, expect, test } from "bun:test";
import { BadRequestError } from "@procella/types";
import { ALL_WEBHOOK_EVENTS, signPayload, validateWebhookUrl, WebhookEvent } from "./index.js";

describe("@procella/webhooks", () => {
	test("signPayload is deterministic for same payload + secret", async () => {
		const payload = JSON.stringify({ hello: "world" });
		const secret = "secret-a";
		const a = await signPayload(payload, secret);
		const b = await signPayload(payload, secret);
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-f0-9]{64}$/);
	});

	test("signPayload differs for different secrets", async () => {
		const payload = JSON.stringify({ hello: "world" });
		const a = await signPayload(payload, "secret-a");
		const b = await signPayload(payload, "secret-b");
		expect(a).not.toBe(b);
	});

	test("WebhookEvent constants match expected strings", () => {
		expect(WebhookEvent.STACK_CREATED).toBe("stack.created");
		expect(WebhookEvent.STACK_DELETED).toBe("stack.deleted");
		expect(WebhookEvent.STACK_UPDATED).toBe("stack.updated");
		expect(WebhookEvent.UPDATE_STARTED).toBe("update.started");
		expect(WebhookEvent.UPDATE_SUCCEEDED).toBe("update.succeeded");
		expect(WebhookEvent.UPDATE_FAILED).toBe("update.failed");
		expect(WebhookEvent.UPDATE_CANCELLED).toBe("update.cancelled");
		expect(ALL_WEBHOOK_EVENTS).toContain("stack.created");
		expect(ALL_WEBHOOK_EVENTS).toContain("update.cancelled");
	});

	test("generated secret uses UUID format when unspecified", () => {
		const secret = crypto.randomUUID();
		expect(secret).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
	});

	describe("validateWebhookUrl", () => {
		test("allows public HTTPS URLs", () => {
			expect(() => validateWebhookUrl("https://example.com/webhook")).not.toThrow();
			expect(() => validateWebhookUrl("https://hooks.slack.com/services/T123")).not.toThrow();
			expect(() => validateWebhookUrl("http://203.0.113.1:8080/hook")).not.toThrow();
		});

		test("blocks localhost", () => {
			expect(() => validateWebhookUrl("http://localhost:9090/api")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://localhost/")).toThrow(BadRequestError);
		});

		test("blocks loopback IPs", () => {
			expect(() => validateWebhookUrl("http://127.0.0.1/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://127.0.0.99:8080/hook")).toThrow(BadRequestError);
		});

		test("blocks AWS/cloud metadata endpoint", () => {
			expect(() => validateWebhookUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
				BadRequestError,
			);
		});

		test("blocks private class A (10.x)", () => {
			expect(() => validateWebhookUrl("http://10.0.0.1/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://10.255.255.255/")).toThrow(BadRequestError);
		});

		test("blocks private class B (172.16-31.x)", () => {
			expect(() => validateWebhookUrl("http://172.16.0.1/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("http://172.31.255.255/")).toThrow(BadRequestError);
		});

		test("blocks private class C (192.168.x)", () => {
			expect(() => validateWebhookUrl("http://192.168.1.1/")).toThrow(BadRequestError);
		});

		test("blocks IPv6 loopback", () => {
			expect(() => validateWebhookUrl("http://[::1]/")).toThrow(BadRequestError);
		});

		test("blocks GCP metadata hostname", () => {
			expect(() => validateWebhookUrl("http://metadata.google.internal/")).toThrow(BadRequestError);
		});

		test("blocks non-HTTP protocols", () => {
			expect(() => validateWebhookUrl("ftp://example.com/")).toThrow(BadRequestError);
			expect(() => validateWebhookUrl("file:///etc/passwd")).toThrow(BadRequestError);
		});

		test("blocks link-local range", () => {
			expect(() => validateWebhookUrl("http://169.254.1.1/")).toThrow(BadRequestError);
		});
	});
});
