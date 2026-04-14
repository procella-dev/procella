import * as log from "./log.js";
import { discoverStacks, exportState, filterStacks } from "./procella.js";
import type { ValidateOptions, ValidationResult } from "./types.js";

export async function validate(opts: ValidateOptions): Promise<ValidationResult[]> {
	log.heading("Validating migration");

	// Discover stacks on both sides
	const [sourceStacks, targetStacks] = await Promise.all([
		discoverStacks(opts.sourceUrl, opts.sourceToken),
		discoverStacks(opts.targetUrl, opts.targetToken),
	]);

	const filteredSource = filterStacks(sourceStacks, opts.filter, opts.exclude || undefined);
	const targetByFqn = new Map(targetStacks.map((s) => [s.fqn, s]));

	const results: ValidationResult[] = [];

	for (const source of filteredSource) {
		// Normalize source FQN the same way migration does:
		// DIY stacks (no org) become imported/<project>/<stack> on Procella
		const normalizedOrg = source.ref.org || "imported";
		const normalizedProject = source.ref.project || source.ref.stack || "default";
		const normalizedFqn = `${normalizedOrg}/${normalizedProject}/${source.ref.stack}`;
		const target = targetByFqn.get(source.fqn) ?? targetByFqn.get(normalizedFqn);

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
	const sourceByFqn = new Set(filteredSource.map((s) => s.fqn));
	const normalizedSourceFqns = new Set(
		filteredSource.map((s) => {
			const o = s.ref.org || "imported";
			const p = s.ref.project || s.ref.stack || "default";
			return `${o}/${p}/${s.ref.stack}`;
		}),
	);
	const filteredTarget = filterStacks(targetStacks, opts.filter, opts.exclude || undefined);
	for (const target of filteredTarget) {
		if (!sourceByFqn.has(target.fqn) && !normalizedSourceFqns.has(target.fqn)) {
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
			r.missingOnTarget.length + r.missingOnSource.length > 0
				? `${r.missingOnTarget.length} missing on target, ${r.missingOnSource.length} extra`
				: (r.error ?? "—"),
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
