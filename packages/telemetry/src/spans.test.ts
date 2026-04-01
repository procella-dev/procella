import { describe, expect, test } from "bun:test";
import { getTracer, withDbSpan, withSpan } from "./spans.js";

describe("@procella/telemetry spans", () => {
	describe("withSpan", () => {
		test("returns the result of the wrapped function", async () => {
			const result = await withSpan("test", "test.op", {}, async () => "hello");
			expect(result).toBe("hello");
		});

		test("propagates errors from the wrapped function", async () => {
			await expect(
				withSpan("test", "test.fail", {}, async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
		});

		test("passes attributes without error", async () => {
			const result = await withSpan(
				"test.tracer",
				"test.op",
				{ "custom.attr": "value", "custom.num": 42 },
				async () => 123,
			);
			expect(result).toBe(123);
		});

		test("handles non-Error exceptions", async () => {
			await expect(
				withSpan("test", "test.string-throw", {}, async () => {
					throw "string-error";
				}),
			).rejects.toThrow();
		});
	});

	describe("withDbSpan", () => {
		test("returns the result of the wrapped function", async () => {
			const result = await withDbSpan("select", { table: "stacks" }, async () => [{ id: "1" }]);
			expect(result).toEqual([{ id: "1" }]);
		});

		test("propagates errors", async () => {
			await expect(
				withDbSpan("insert", {}, async () => {
					throw new Error("db error");
				}),
			).rejects.toThrow("db error");
		});

		test("records db operation metrics", async () => {
			// This test verifies that the function completes without error
			// when metrics are recorded (metrics are no-ops without a real exporter)
			await withDbSpan("update", { "db.table": "updates" }, async () => undefined);
		});
	});

	describe("getTracer", () => {
		test("returns a tracer instance", () => {
			const tracer = getTracer("test.tracer");
			expect(tracer).toBeDefined();
			expect(typeof tracer.startActiveSpan).toBe("function");
			expect(typeof tracer.startSpan).toBe("function");
		});

		test("returns tracer for different names", () => {
			const t1 = getTracer("tracer.a");
			const t2 = getTracer("tracer.b");
			expect(t1).toBeDefined();
			expect(t2).toBeDefined();
		});
	});
});
