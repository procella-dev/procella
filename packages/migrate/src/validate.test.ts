import { describe, expect, test } from "bun:test";
import type { DiscoveredStack } from "./types.js";
import { findMatchingTargetStack, hasMatchingSourceStack } from "./validate.js";

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
