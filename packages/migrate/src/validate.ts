import {
	destinationCollisionMessage,
	destinationIdentity,
	destinationRef,
	findDestinationCollisions,
} from "./destination.js";
import * as log from "./log.js";
import { discoverStacks, exportState, filterStacks } from "./procella.js";
import type { DiscoveredStack, StackRef, ValidateOptions, ValidationResult } from "./types.js";

interface ValidationOperations {
	discoverStacks: typeof discoverStacks;
	exportState: typeof exportState;
	exportFromBackend: typeof exportFromBackend;
}

const defaultValidationOperations: ValidationOperations = {
	discoverStacks,
	exportState,
	exportFromBackend,
};

export async function validate(
	opts: ValidateOptions,
	operations: ValidationOperations = defaultValidationOperations,
): Promise<ValidationResult[]> {
	log.heading("Validating migration");

	// Discover stacks on both sides
	const [sourceStacks, targetStacks] = await Promise.all([
		operations.discoverStacks(opts.sourceUrl, opts.sourceToken),
		operations.discoverStacks(opts.targetUrl, opts.targetToken),
	]);

	const filteredSource = filterStacks(sourceStacks, opts.filter, opts.exclude || undefined);
	const sourceCollisions = findDestinationCollisions(filteredSource);
	const collisionByIdentity = new Map(
		sourceCollisions.map((collision) => [collision.key, collision]),
	);

	// Build target lookup once. `findMatchingTargetStack` would otherwise
	// rebuild it on every iteration, making validation O(n²) over stacks.
	const targetLookup = buildTargetLookup(targetStacks);

	const results: ValidationResult[] = [];

	for (const source of filteredSource) {
		const sourceCollision = collisionByIdentity.get(destinationIdentity(source.ref));
		if (sourceCollision) {
			results.push({
				fqn: source.fqn,
				status: "error",
				sourceResourceCount: source.resourceCount ?? 0,
				targetResourceCount: 0,
				missingOnTarget: [],
				missingOnSource: [],
				error: destinationCollisionMessage(sourceCollision),
			});
			continue;
		}

		const target = findMatchingTargetStack(source, targetLookup);

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
				operations.exportFromBackend(opts.sourceUrl, opts.sourceToken, source.ref),
				operations.exportState(
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
	// Build source lookup once. Same O(n²) hazard as the target loop above.
	const sourceLookup = buildSourceLookup(filteredSource);
	for (const target of filteredTarget) {
		if (collisionByIdentity.has(destinationIdentity(target.ref))) continue;
		if (!hasMatchingSourceStack(target, sourceLookup)) {
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

/**
 * Precomputed lookup tables for `findMatchingTargetStack`. Build once per
 * `validate()` invocation and reuse across all source stacks.
 */
export interface TargetLookup {
	readonly byFqn: ReadonlyMap<string, DiscoveredStack>;
	/** value === null means more than one stack shares the project/stack key */
	readonly byProjectStack: ReadonlyMap<string, DiscoveredStack | null>;
}

/** Build a `TargetLookup` from a list of target stacks. O(n). */
export function buildTargetLookup(targetStacks: DiscoveredStack[]): TargetLookup {
	const byFqn = new Map<string, DiscoveredStack>();
	for (const stack of targetStacks) {
		byFqn.set(stack.fqn, stack);
	}
	return { byFqn, byProjectStack: buildProjectStackLookup(targetStacks) };
}

export function findMatchingTargetStack(
	source: DiscoveredStack,
	targetStacksOrLookup: DiscoveredStack[] | TargetLookup,
): DiscoveredStack | undefined {
	const lookup = Array.isArray(targetStacksOrLookup)
		? buildTargetLookup(targetStacksOrLookup)
		: targetStacksOrLookup;
	const normalizedRef = normalizeStackRef(source.ref);
	const normalizedFqn = stackFqn(normalizedRef);
	return (
		lookup.byFqn.get(source.fqn) ??
		lookup.byFqn.get(normalizedFqn) ??
		getUniqueProjectStackMatch(lookup.byProjectStack, source.ref)
	);
}

/**
 * Precomputed lookup tables for `hasMatchingSourceStack`. Build once per
 * `validate()` invocation and reuse across all target stacks.
 */
export interface SourceLookup {
	readonly fqns: ReadonlySet<string>;
	readonly normalizedFqns: ReadonlySet<string>;
	readonly projectStackKeys: ReadonlySet<string>;
	/** Project/stack keys owned by more than one distinct source FQN. */
	readonly ambiguousProjectStackKeys: ReadonlySet<string>;
}

/** Build a `SourceLookup` from a list of source stacks. O(n). */
export function buildSourceLookup(sourceStacks: DiscoveredStack[]): SourceLookup {
	const fqns = new Set<string>();
	const normalizedFqns = new Set<string>();
	const projectStackKeys = new Set<string>();
	const sourceFqnByProjectStack = new Map<string, string>();
	const ambiguousProjectStackKeys = new Set<string>();
	for (const source of sourceStacks) {
		fqns.add(source.fqn);
		normalizedFqns.add(stackFqn(normalizeStackRef(source.ref)));
		const key = projectStackKey(source.ref);
		projectStackKeys.add(key);
		const previousSource = sourceFqnByProjectStack.get(key);
		if (previousSource !== undefined && previousSource !== source.fqn) {
			ambiguousProjectStackKeys.add(key);
		} else {
			sourceFqnByProjectStack.set(key, source.fqn);
		}
	}
	return { fqns, normalizedFqns, projectStackKeys, ambiguousProjectStackKeys };
}

export function hasMatchingSourceStack(
	target: DiscoveredStack,
	sourceStacksOrLookup: DiscoveredStack[] | SourceLookup,
): boolean {
	const lookup = Array.isArray(sourceStacksOrLookup)
		? buildSourceLookup(sourceStacksOrLookup)
		: sourceStacksOrLookup;
	if (lookup.ambiguousProjectStackKeys.has(projectStackKey(target.ref))) return false;
	return (
		lookup.fqns.has(target.fqn) ||
		lookup.normalizedFqns.has(target.fqn) ||
		lookup.projectStackKeys.has(projectStackKey(target.ref))
	);
}

function normalizeStackRef(ref: StackRef): StackRef {
	return destinationRef(ref);
}

function stackFqn(ref: StackRef): string {
	return `${ref.org}/${ref.project}/${ref.stack}`;
}

function projectStackKey(ref: StackRef): string {
	return destinationIdentity(ref);
}

function buildProjectStackLookup(stacks: DiscoveredStack[]): Map<string, DiscoveredStack | null> {
	const lookup = new Map<string, DiscoveredStack | null>();
	for (const stack of stacks) {
		const key = projectStackKey(stack.ref);
		const previous = lookup.get(key);
		if (previous === null) continue;
		if (previous !== undefined && previous.fqn !== stack.fqn) {
			lookup.set(key, null);
			continue;
		}
		lookup.set(key, stack);
	}
	return lookup;
}

function getUniqueProjectStackMatch(
	lookup: ReadonlyMap<string, DiscoveredStack | null>,
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
