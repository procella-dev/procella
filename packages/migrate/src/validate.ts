import * as log from "./log.js";
import { discoverStacks, exportState, filterStacks } from "./procella.js";
import type { DiscoveredStack, StackRef, ValidateOptions, ValidationResult } from "./types.js";

export async function validate(opts: ValidateOptions): Promise<ValidationResult[]> {
	log.heading("Validating migration");

	// Discover stacks on both sides
	const [sourceStacks, targetStacks] = await Promise.all([
		discoverStacks(opts.sourceUrl, opts.sourceToken),
		discoverStacks(opts.targetUrl, opts.targetToken),
	]);

	const filteredSource = filterStacks(sourceStacks, opts.filter, opts.exclude || undefined);

	const results: ValidationResult[] = [];

	for (const source of filteredSource) {
		const target = findMatchingTargetStack(source, targetStacks);

		if (!target) {
			results.push({
				fqn: source.fqn,
				status: "missing-target",
				sourceResourceCount: source.resourceCount ?? 0,
				targetResourceCount: 0,
				missingOnTarget: [],
				missingOnSource: [],
			});
			continue;
		}

		// Deep comparison: export state from both and compare URNs
		try {
			const [sourceState, targetState] = await Promise.all([
				exportFromBackend(opts.sourceUrl, opts.sourceToken, source.ref),
				exportState(
					{ url: opts.targetUrl, token: opts.targetToken },
					target.ref.org,
					target.ref.project,
					target.ref.stack,
				),
			]);

			const sourceUrns = new Set((sourceState.deployment.resources ?? []).map((r) => r.urn));
			const targetUrns = new Set((targetState.deployment.resources ?? []).map((r) => r.urn));

			const missingOnTarget = [...sourceUrns].filter((u) => !targetUrns.has(u));
			const missingOnSource = [...targetUrns].filter((u) => !sourceUrns.has(u));

			const match = missingOnTarget.length === 0 && missingOnSource.length === 0;

			results.push({
				fqn: source.fqn,
				status: match ? "match" : "mismatch",
				sourceResourceCount: sourceUrns.size,
				targetResourceCount: targetUrns.size,
				missingOnTarget,
				missingOnSource,
			});
		} catch (err) {
			results.push({
				fqn: source.fqn,
				status: "error",
				sourceResourceCount: source.resourceCount ?? 0,
				targetResourceCount: target.resourceCount ?? 0,
				missingOnTarget: [],
				missingOnSource: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Check for stacks that exist on target but not on source
	const filteredTarget = filterStacks(targetStacks, opts.filter, opts.exclude || undefined);
	for (const target of filteredTarget) {
		if (!hasMatchingSourceStack(target, filteredSource)) {
			results.push({
				fqn: target.fqn,
				status: "missing-source",
				sourceResourceCount: 0,
				targetResourceCount: target.resourceCount ?? 0,
				missingOnTarget: [],
				missingOnSource: [],
			});
		}
	}

	// Report
	log.info("");
	log.table(
		["Stack", "Status", "Source", "Target", "Diff"],
		results.map((r) => [
			r.fqn,
			statusLabel(r.status),
			String(r.sourceResourceCount),
			String(r.targetResourceCount),
			formatDiffSummary(r),
		]),
	);

	const matches = results.filter((r) => r.status === "match").length;
	const mismatches = results.filter((r) => r.status !== "match").length;

	log.info(`\n${matches} match, ${mismatches} issues`);

	if (results.length === 0) {
		log.warn("No stacks matched the filter on either backend. Nothing to validate.");
	}

	return results;
}

export function formatDiffSummary(result: ValidationResult): string {
	if (result.missingOnTarget.length + result.missingOnSource.length > 0) {
		return `${result.missingOnTarget.length} missing on target, ${result.missingOnSource.length} extra`;
	}

	switch (result.status) {
		case "missing-target":
			return "stack missing on target";
		case "missing-source":
			return "stack missing on source";
		case "error":
			return result.error ?? "validation error";
		default:
			return result.error ?? "—";
	}
}

export function findMatchingTargetStack(
	source: DiscoveredStack,
	targetStacks: DiscoveredStack[],
): DiscoveredStack | undefined {
	const targetByFqn = new Map(targetStacks.map((stack) => [stack.fqn, stack]));
	const targetByProjectStack = buildProjectStackLookup(targetStacks);
	const normalizedRef = normalizeStackRef(source.ref);
	const normalizedFqn = stackFqn(normalizedRef);
	return (
		targetByFqn.get(source.fqn) ??
		targetByFqn.get(normalizedFqn) ??
		getUniqueProjectStackMatch(targetByProjectStack, source.ref)
	);
}

export function hasMatchingSourceStack(
	target: DiscoveredStack,
	sourceStacks: DiscoveredStack[],
): boolean {
	const sourceByFqn = new Set(sourceStacks.map((source) => source.fqn));
	const normalizedSourceFqns = new Set(
		sourceStacks.map((source) => stackFqn(normalizeStackRef(source.ref))),
	);
	const sourceByProjectStack = new Set(sourceStacks.map((source) => projectStackKey(source.ref)));
	return (
		sourceByFqn.has(target.fqn) ||
		normalizedSourceFqns.has(target.fqn) ||
		sourceByProjectStack.has(projectStackKey(target.ref))
	);
}

function normalizeStackRef(ref: StackRef): StackRef {
	return {
		org: ref.org || "imported",
		project: ref.project || ref.stack || "default",
		stack: ref.stack,
	};
}

function stackFqn(ref: StackRef): string {
	return `${ref.org}/${ref.project}/${ref.stack}`;
}

function projectStackKey(ref: StackRef): string {
	return `${ref.project || ref.stack || "default"}/${ref.stack}`;
}

function buildProjectStackLookup(stacks: DiscoveredStack[]): Map<string, DiscoveredStack | null> {
	const lookup = new Map<string, DiscoveredStack | null>();
	for (const stack of stacks) {
		const key = projectStackKey(stack.ref);
		if (lookup.has(key)) {
			lookup.set(key, null);
			continue;
		}
		lookup.set(key, stack);
	}
	return lookup;
}

function getUniqueProjectStackMatch(
	lookup: Map<string, DiscoveredStack | null>,
	ref: StackRef,
): DiscoveredStack | undefined {
	return lookup.get(projectStackKey(ref)) ?? undefined;
}

function statusLabel(status: ValidationResult["status"]): string {
	switch (status) {
		case "match":
			return "✓ match";
		case "mismatch":
			return "✗ mismatch";
		case "missing-target":
			return "✗ not migrated";
		case "missing-source":
			return "? extra on target";
		case "error":
			return "✗ error";
	}
}

/** Export state from a backend — tries Procella API first, falls back to CLI temp file. */
async function exportFromBackend(
	url: string,
	token: string,
	ref: { org: string; project: string; stack: string },
): Promise<import("./types.js").UntypedDeployment> {
	if (url.startsWith("http://") || url.startsWith("https://")) {
		try {
			return await exportState({ url, token }, ref.org, ref.project, ref.stack);
		} catch {
			// Fall through to CLI
		}
	}

	// CLI fallback: export to temp file
	const { mkdtemp, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { exportStack } = await import("./pulumi.js");

	const dir = await mkdtemp(join(tmpdir(), "procella-validate-"));
	const file = join(dir, "state.json");
	const fqn = ref.org
		? `${ref.org}/${ref.project}/${ref.stack}`
		: ref.project
			? `${ref.project}/${ref.stack}`
			: ref.stack;

	try {
		await exportStack(fqn, file, { backendUrl: url, token });
		const content = await readFile(file, "utf-8");
		return JSON.parse(content);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
