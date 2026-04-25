import { describe, expect, mock, test } from "bun:test";
import { filterStacks } from "./procella.js";
import type { DiscoveredStack } from "./types.js";

function makeStack(fqn: string): DiscoveredStack {
	const parts = fqn.split("/");
	return {
		fqn,
		ref: {
			org: parts[0] ?? "",
			project: parts[1] ?? "",
			stack: parts[2] ?? "",
		},
		resourceCount: 10,
		lastUpdate: null,
	};
}

describe("filterStacks", () => {
	const stacks = [
		makeStack("myorg/payments/dev"),
		makeStack("myorg/payments/staging"),
		makeStack("myorg/payments/production"),
		makeStack("myorg/auth/dev"),
		makeStack("myorg/auth/production"),
		makeStack("other/infra/dev"),
	];

	test("wildcard matches all", () => {
		expect(filterStacks(stacks, "*")).toHaveLength(6);
	});

	test("filters by exact FQN", () => {
		const result = filterStacks(stacks, "myorg/payments/dev");
		expect(result).toHaveLength(1);
		expect(result[0].fqn).toBe("myorg/payments/dev");
	});

	test("filters by project wildcard", () => {
		const result = filterStacks(stacks, "myorg/payments/*");
		expect(result).toHaveLength(3);
		expect(result.map((s) => s.fqn)).toEqual([
			"myorg/payments/dev",
			"myorg/payments/staging",
			"myorg/payments/production",
		]);
	});

	test("filters by stack name across projects", () => {
		const result = filterStacks(stacks, "*/*/dev");
		expect(result).toHaveLength(3);
		expect(result.map((s) => s.fqn)).toEqual([
			"myorg/payments/dev",
			"myorg/auth/dev",
			"other/infra/dev",
		]);
	});

	test("filters by org wildcard", () => {
		const result = filterStacks(stacks, "myorg/*/*");
		expect(result).toHaveLength(5);
	});

	test("globstar matches across slashes", () => {
		const result = filterStacks(stacks, "**dev");
		expect(result).toHaveLength(3);
	});

	test("exclude removes matching stacks", () => {
		const result = filterStacks(stacks, "myorg/*/*", "*/*/production");
		expect(result).toHaveLength(3);
		expect(result.every((s) => s.ref.stack !== "production")).toBe(true);
	});

	test("exclude with project pattern", () => {
		const result = filterStacks(stacks, "*", "myorg/auth/*");
		expect(result).toHaveLength(4);
		expect(result.every((s) => s.ref.project !== "auth")).toBe(true);
	});

	test("no matches returns empty", () => {
		expect(filterStacks(stacks, "nonexistent/*")).toHaveLength(0);
	});

	test("? is treated as a literal character, not a regex quantifier", () => {
		const withQuestion = [
			makeStack("myorg/api-v2?/dev"),
			makeStack("myorg/api-v/dev"),
			makeStack("myorg/api-v2/dev"),
		];
		const result = filterStacks(withQuestion, "myorg/api-v2?/dev");
		expect(result).toHaveLength(1);
		expect(result[0].fqn).toBe("myorg/api-v2?/dev");
	});
});

function mockFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
	// biome-ignore lint/suspicious/noExplicitAny: Bun fetch includes preconnect which mocks don't have
	(globalThis as any).fetch = mock(impl);
}

describe("Procella HTTP client", () => {
	test("healthCheck returns true on 200", async () => {
		const originalFetch = globalThis.fetch;
		mockFetch(async () => new Response("ok", { status: 200 }));
		try {
			const { healthCheck } = await import("./procella.js");
			const result = await healthCheck("http://localhost:9090");
			expect(result).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("healthCheck returns false on network error", async () => {
		const originalFetch = globalThis.fetch;
		mockFetch(async () => {
			throw new Error("ECONNREFUSED");
		});
		try {
			const { healthCheck } = await import("./procella.js");
			const result = await healthCheck("http://unreachable:9090");
			expect(result).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("healthCheck returns false on non-OK status", async () => {
		const originalFetch = globalThis.fetch;
		mockFetch(async () => new Response("error", { status: 500 }));
		try {
			const { healthCheck } = await import("./procella.js");
			const result = await healthCheck("http://localhost:9090");
			expect(result).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
