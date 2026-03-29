interface PulumiResource {
	urn: string;
	parent?: string;
	dependencies?: string[];
	[key: string]: unknown;
}

export interface RepairMutation {
	type: "remove-orphan" | "fix-dangling-parent";
	urn: string;
	detail: string;
}

export function detectDanglingParents(resources: PulumiResource[]): string[] {
	const urns = new Set(resources.map((r) => r.urn));
	return resources.filter((r) => r.parent && !urns.has(r.parent)).map((r) => r.urn);
}

export function detectOrphans(resources: PulumiResource[]): string[] {
	const reachable = new Set<string>();

	for (const resource of resources) {
		if (!resource.parent) reachable.add(resource.urn);
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const resource of resources) {
			if (!reachable.has(resource.urn) && resource.parent && reachable.has(resource.parent)) {
				reachable.add(resource.urn);
				changed = true;
			}
		}
	}

	return resources.filter((r) => !reachable.has(r.urn)).map((r) => r.urn);
}

function reachableFrom(resources: PulumiResource[], roots: Set<string>): Set<string> {
	const reachable = new Set<string>(roots);
	let changed = true;
	while (changed) {
		changed = false;
		for (const resource of resources) {
			if (!reachable.has(resource.urn) && resource.parent && reachable.has(resource.parent)) {
				reachable.add(resource.urn);
				changed = true;
			}
		}
	}
	return reachable;
}

export function repairCheckpoint(resources: PulumiResource[]): {
	resources: PulumiResource[];
	mutations: RepairMutation[];
} {
	const mutations: RepairMutation[] = [];
	const urns = new Set(resources.map((r) => r.urn));
	const originalRoots = new Set(resources.filter((r) => !r.parent).map((r) => r.urn));
	const danglingUrns = new Set(
		resources.filter((r) => r.parent && !urns.has(r.parent)).map((r) => r.urn),
	);

	let patched = resources.map((resource) => {
		if (danglingUrns.has(resource.urn)) {
			mutations.push({
				type: "fix-dangling-parent",
				urn: resource.urn,
				detail: `removed parent ref ${resource.parent}`,
			});
			return { ...resource, parent: undefined };
		}
		return resource;
	});

	const hasValidEdges = resources.some((r) => r.parent && urns.has(r.parent));

	if (hasValidEdges) {
		while (true) {
			const reachable = reachableFrom(patched, originalRoots);
			const orphans = new Set(patched.filter((r) => !reachable.has(r.urn)).map((r) => r.urn));

			if (orphans.size === 0) {
				break;
			}

			for (const urn of orphans) {
				mutations.push({ type: "remove-orphan", urn, detail: "unreachable from root" });
			}

			patched = patched.filter((r) => !orphans.has(r.urn));
		}
	}

	return { resources: patched, mutations };
}
