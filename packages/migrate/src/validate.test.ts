import { describe, expect, test } from "bun:test";
import type { DiscoveredStack } from "./types.js";
import {
	buildSourceLookup,
	buildTargetLookup,
	findMatchingTargetStack,
	formatDiffSummary,
	hasMatchingSourceStack,
} from "./validate.js";

function makeStack(fqn: string, resourceCount: number = 1): DiscoveredStack {
	const [org = "", project = "", stack = ""] = fqn.split("/");
	return {
		fqn,
		ref: { org, project, stack },
		resourceCount,
		lastUpdate: null,
	};
}

describe("findMatchingTargetStack", () => {
	test("falls back to project/stack when Procella reports a different org slug", () => {
		const source = makeStack("legacy/payments/dev");
		const target = makeStack("tenant-a/payments/dev");

		expect(findMatchingTargetStack(source, [target])).toEqual(target);
	});

	test("does not use an ambiguous project/stack fallback", () => {
		const source = makeStack("legacy/payments/dev");
		const targetStacks = [makeStack("tenant-a/payments/dev"), makeStack("tenant-b/payments/dev")];

		expect(findMatchingTargetStack(source, targetStacks)).toBeUndefined();
	});
});

describe("hasMatchingSourceStack", () => {
	test("treats a target stack as matched when only the org differs", () => {
		const sourceStacks = [makeStack("legacy/payments/dev")];
		const target = makeStack("tenant-a/payments/dev");

		expect(hasMatchingSourceStack(target, sourceStacks)).toBe(true);
	});

	test("still reports a target-only stack when project/stack is missing on the source", () => {
		const sourceStacks = [makeStack("legacy/payments/dev")];
		const target = makeStack("tenant-a/billing/dev");

		expect(hasMatchingSourceStack(target, sourceStacks)).toBe(false);
	});
});

// Regression for the O(n²) review feedback on PR #123: both matchers used to
// rebuild their lookup tables on every call (once per source/target stack in
// `validate()`). They now accept an optional precomputed lookup. These tests
// pin the new contract — same results either way — and ensure the lookup
// builders are pure / idempotent so the loop in `validate()` can build once.
describe("buildTargetLookup / findMatchingTargetStack precomputed", () => {
	test("findMatchingTargetStack returns identical results with array vs precomputed lookup", () => {
		const source = makeStack("legacy/payments/dev");
		const targetStacks = [makeStack("tenant-a/payments/dev"), makeStack("tenant-b/billing/prod")];
		const lookup = buildTargetLookup(targetStacks);

		expect(findMatchingTargetStack(source, lookup)).toEqual(
			findMatchingTargetStack(source, targetStacks),
		);
	});

	test("buildTargetLookup is a pure O(n) builder reusable across many sources", () => {
		const targetStacks = [
			makeStack("tenant-a/payments/dev"),
			makeStack("tenant-a/payments/prod"),
			makeStack("tenant-b/billing/dev"),
		];
		const lookup = buildTargetLookup(targetStacks);

		// Reusing the same lookup across multiple sources must not mutate it.
		const sources = [
			makeStack("legacy/payments/dev"),
			makeStack("legacy/billing/dev"),
			makeStack("legacy/unknown/x"),
		];
		const results = sources.map((s) => findMatchingTargetStack(s, lookup));
		expect(results[0]?.fqn).toBe("tenant-a/payments/dev");
		expect(results[1]?.fqn).toBe("tenant-b/billing/dev");
		expect(results[2]).toBeUndefined();

		// The lookup tables themselves must be unchanged after use.
		expect(lookup.byFqn.size).toBe(3);
		expect(lookup.byProjectStack.size).toBe(3);
	});
});

describe("buildSourceLookup / hasMatchingSourceStack precomputed", () => {
	test("hasMatchingSourceStack returns identical results with array vs precomputed lookup", () => {
		const sourceStacks = [makeStack("legacy/payments/dev"), makeStack("legacy/billing/prod")];
		const target = makeStack("tenant-a/payments/dev");
		const lookup = buildSourceLookup(sourceStacks);

		expect(hasMatchingSourceStack(target, lookup)).toBe(
			hasMatchingSourceStack(target, sourceStacks),
		);
	});

	test("buildSourceLookup yields a reusable, immutable lookup", () => {
		const sourceStacks = [
			makeStack("legacy/payments/dev"),
			makeStack("legacy/payments/prod"),
			makeStack("legacy/billing/dev"),
		];
		const lookup = buildSourceLookup(sourceStacks);

		const targets = [
			makeStack("tenant-a/payments/dev"),
			makeStack("tenant-a/billing/dev"),
			makeStack("tenant-a/missing/x"),
		];
		const results = targets.map((t) => hasMatchingSourceStack(t, lookup));
		expect(results).toEqual([true, true, false]);

		expect(lookup.fqns.size).toBe(3);
		expect(lookup.normalizedFqns.size).toBe(3);
		expect(lookup.projectStackKeys.size).toBe(3);
	});
});

describe("formatDiffSummary", () => {
	test("describes stacks that are missing on the target", () => {
		expect(
			formatDiffSummary({
				fqn: "legacy/payments/dev",
				status: "missing-target",
				sourceResourceCount: 3,
				targetResourceCount: 0,
				missingOnTarget: [],
				missingOnSource: [],
			}),
		).toBe("stack missing on target");
	});

	test("describes stacks that are missing on the source", () => {
		expect(
			formatDiffSummary({
				fqn: "tenant-a/payments/dev",
				status: "missing-source",
				sourceResourceCount: 0,
				targetResourceCount: 3,
				missingOnTarget: [],
				missingOnSource: [],
			}),
		).toBe("stack missing on source");
	});
});
