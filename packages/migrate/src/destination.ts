import type { DiscoveredStack, StackRef } from "./types.js";

export interface DestinationCollision {
	key: string;
	identity: string;
	sourceFqns: string[];
}

/** Map a discovered source reference to the route coordinates used for migration. */
export function destinationRef(ref: StackRef): StackRef {
	return {
		org: ref.org || "imported",
		project: ref.project || ref.stack || "default",
		stack: ref.stack,
	};
}

/**
 * Procella scopes stacks to the authenticated target tenant. The source org is
 * accepted in the API path for compatibility but is not part of target identity.
 */
export function destinationIdentity(ref: StackRef): string {
	const target = destinationRef(ref);
	return JSON.stringify([target.project, target.stack]);
}

export function formatDestinationIdentity(ref: StackRef): string {
	const target = destinationRef(ref);
	return `${target.project}/${target.stack}`;
}

/** Find distinct source stacks that collapse to one effective target stack. */
export function findDestinationCollisions(stacks: DiscoveredStack[]): DestinationCollision[] {
	const byIdentity = new Map<string, { display: string; sourceFqns: Set<string> }>();
	for (const stack of stacks) {
		const identity = destinationIdentity(stack.ref);
		const entry = byIdentity.get(identity) ?? {
			display: formatDestinationIdentity(stack.ref),
			sourceFqns: new Set<string>(),
		};
		entry.sourceFqns.add(stack.fqn);
		byIdentity.set(identity, entry);
	}

	const collisions: DestinationCollision[] = [];
	for (const [key, { display, sourceFqns }] of byIdentity) {
		if (sourceFqns.size > 1) {
			collisions.push({ key, identity: display, sourceFqns: [...sourceFqns] });
		}
	}
	return collisions;
}

export function destinationCollisionMessage(collision: DestinationCollision): string {
	return `Ambiguous target ${collision.identity}: conflicting sources ${collision.sourceFqns.join(", ")}`;
}
