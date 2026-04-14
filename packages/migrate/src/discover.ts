import * as log from "./log.js";
import { discoverStacks, filterStacks } from "./procella.js";
import type { DiscoverOptions } from "./types.js";

export async function discover(opts: DiscoverOptions): Promise<void> {
	// In JSON mode, only write machine-readable output to stdout
	if (opts.format !== "json") {
		log.heading("Discovering stacks");
		log.dim(`Source: ${opts.sourceUrl}`);
	}

	const stacks = await discoverStacks(opts.sourceUrl, opts.sourceToken);
	const filtered = filterStacks(stacks, opts.filter, opts.exclude || undefined);

	if (opts.format === "json") {
		process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
		return;
	}

	if (filtered.length === 0) {
		log.warn("No stacks found matching the filter.");
		return;
	}

	const totalResources = filtered.reduce((sum, s) => sum + (s.resourceCount ?? 0), 0);

	log.table(
		["Stack", "Resources", "Last Updated"],
		filtered.map((s) => [
			s.fqn,
			s.resourceCount !== null ? String(s.resourceCount) : "—",
			s.lastUpdate ?? "—",
		]),
	);

	log.info(`\n${filtered.length} stacks found, ${totalResources} total resources`);
}
