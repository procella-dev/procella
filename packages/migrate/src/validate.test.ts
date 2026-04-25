import { describe, expect, test } from "bun:test";
import type { DiscoveredStack } from "./types.js";
import { findMatchingTargetStack, formatDiffSummary, hasMatchingSourceStack } from "./validate.js";

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
