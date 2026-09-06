import { describe, expect, mock, test } from "bun:test";
import { batchDecrypt, filterStacks } from "./procella.js";
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

describe("batchDecrypt", () => {
	test("splits requests larger than the server's per-batch item limit", async () => {
		const originalFetch = globalThis.fetch;
		const requestSizes: number[] = [];
		mockFetch(async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { ciphertexts: string[] };
			requestSizes.push(body.ciphertexts.length);
			const plaintexts: Record<string, string> = {};
			for (const ct of body.ciphertexts) {
				plaintexts[ct] = Buffer.from(`plain-${ct}`).toString("base64");
			}
			return new Response(JSON.stringify({ plaintexts }), { status: 200 });
		});
		try {
			const ciphertexts = Array.from({ length: 1500 }, (_, i) => `ct-${i}`);
			const result = await batchDecrypt(
				{ url: "http://localhost:9090", token: "t" },
				"org",
				"proj",
				"stack",
				ciphertexts,
			);
			expect(requestSizes).toEqual([1000, 500]);
			expect(result.size).toBe(1500);
			expect(result.get("ct-0")).toBe("plain-ct-0");
			expect(result.get("ct-1499")).toBe("plain-ct-1499");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("returns an empty map for an empty ciphertext list without any request", async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		mockFetch(async () => {
			calls++;
			return new Response("{}", { status: 200 });
		});
		try {
			const result = await batchDecrypt(
				{ url: "http://localhost:9090", token: "t" },
				"org",
				"proj",
				"stack",
				[],
			);
			expect(result.size).toBe(0);
			expect(calls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
