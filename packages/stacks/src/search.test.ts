import { describe, expect, test } from "bun:test";
import { decodeContinuationToken, encodeContinuationToken, sanitizeTsQuery } from "./index.js";

describe("stack search helpers", () => {
	// ========================================================================
	// sanitizeTsQuery — prefix matching
	// ========================================================================

	describe("sanitizeTsQuery", () => {
		test("single term gets prefix wildcard", () => {
			expect(sanitizeTsQuery("g")).toBe("g:*");
		});

		test("multi-word query joins with AND + prefix wildcards", () => {
			expect(sanitizeTsQuery("comp gam")).toBe("comp:* & gam:*");
		});

		test("full word still matches (prefix of itself)", () => {
			expect(sanitizeTsQuery("gamma")).toBe("gamma:*");
		});

		test("strips SQL injection and keeps valid terms with prefix wildcards", () => {
			expect(sanitizeTsQuery("prod'); DROP TABLE stacks; -- cloud")).toBe(
				"prod:* & DROP:* & TABLE:* & stacks:* & cloud:*",
			);
		});

		test("returns undefined when sanitized query is empty", () => {
			expect(sanitizeTsQuery("!!! ###")).toBeUndefined();
		});

		test("trims leading/trailing whitespace", () => {
			expect(sanitizeTsQuery("  alpha  ")).toBe("alpha:*");
		});

		test("collapses multiple spaces between terms", () => {
			expect(sanitizeTsQuery("alpha   beta")).toBe("alpha:* & beta:*");
		});

		test("preserves underscores in terms", () => {
			expect(sanitizeTsQuery("my_stack")).toBe("my_stack:*");
		});

		test("strips non-alphanumeric except underscores", () => {
			// split is on whitespace, THEN strip — so 'hello-world.test' is one token
			expect(sanitizeTsQuery("hello-world.test")).toBe("helloworldtest:*");
			// with space separator, they become separate terms
			expect(sanitizeTsQuery("hello world")).toBe("hello:* & world:*");
		});

		test("single character matches as prefix", () => {
			// 'g' should match 'gamma', 'component/gamma' etc via tsvector prefix
			const result = sanitizeTsQuery("g");
			expect(result).toBe("g:*");
			expect(result).toContain(":*");
		});
	});

	// ========================================================================
	// Continuation tokens
	// ========================================================================

	describe("continuation tokens", () => {
		test("base64 roundtrip", () => {
			const token = encodeContinuationToken({
				id: "stack-id-123",
				sortValue: "2026-03-24T00:00:00.000Z",
			});

			expect(decodeContinuationToken(token)).toEqual({
				id: "stack-id-123",
				sortValue: "2026-03-24T00:00:00.000Z",
			});
		});

		test("throws on malformed token", () => {
			expect(() => decodeContinuationToken("not-base64")).toThrow("Invalid continuation token");
		});
	});
});
