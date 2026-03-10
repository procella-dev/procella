// @procella/types — Procella domain types.

// ============================================================================
// Role RBAC
// ============================================================================

export const Role = {
	Admin: "admin",
	Member: "member",
	Viewer: "viewer",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

// ============================================================================
// Caller (authenticated user/service)
// ============================================================================

export interface Caller {
	readonly tenantId: string;
	readonly userId: string;
	readonly login: string;
	readonly roles: readonly Role[];
}

/** Check if a caller has a specific role. */
export function hasRole(caller: Caller, role: Role): boolean {
	return caller.roles.includes(role);
}

/** Check if a caller has any of the given roles. */
export function hasAnyRole(caller: Caller, ...roles: Role[]): boolean {
	return roles.some((role) => caller.roles.includes(role));
}

// ============================================================================
// StackFQN (fully-qualified stack name: org/project/stack)
// ============================================================================

export interface StackFQN {
	readonly org: string;
	readonly project: string;
	readonly stack: string;
}

/** Format a StackFQN as "org/project/stack". */
export function formatStackFQN(fqn: StackFQN): string {
	return `${fqn.org}/${fqn.project}/${fqn.stack}`;
}

/** Parse a string into a StackFQN. */
export function parseStackFQN(s: string): StackFQN {
	const parts = s.split("/");
	if (parts.length !== 3) {
		throw new Error(`Invalid stack FQN: ${s}`);
	}
	return { org: parts[0], project: parts[1], stack: parts[2] };
}
