// @procella/updates — Pure helper functions.

import type { UntypedDeployment } from "@procella/types";
import { InvalidUpdateTokenError } from "@procella/types";
import { LEASE_DURATION_SECONDS } from "./types.js";

// ============================================================================
// Lease Token
// ============================================================================

/** Generate a lease token string for an active update. */
export function generateLeaseToken(updateId: string, stackId: string): string {
	return `update:${updateId}:${stackId}`;
}

/** Parse a lease token back into its components. */
export function parseLeaseToken(token: string): { updateId: string; stackId: string } {
	const parts = token.split(":");
	if (parts.length !== 3 || parts[0] !== "update" || !parts[1] || !parts[2]) {
		throw new InvalidUpdateTokenError();
	}
	return { updateId: parts[1], stackId: parts[2] };
}

// ============================================================================
// Blob Storage Keys
// ============================================================================

/** Format the blob storage key for a checkpoint. */
export function formatBlobKey(stackId: string, updateId: string, version: number): string {
	return `checkpoints/${stackId}/${updateId}/${version}`;
}

// ============================================================================
// JSON Merge Patch (RFC 7396)
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply a JSON merge patch (RFC 7396) to a base value.
 *
 * - If delta is not a plain object, it replaces base entirely.
 * - For each key in delta: null deletes, objects recurse, everything else overwrites.
 */
export function applyDelta(base: unknown, delta: unknown): unknown {
	if (!isPlainObject(delta)) {
		return delta;
	}

	const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};

	for (const [key, value] of Object.entries(delta)) {
		if (value === null) {
			delete result[key];
		} else if (isPlainObject(value) && isPlainObject(result[key])) {
			result[key] = applyDelta(result[key], value);
		} else {
			result[key] = value;
		}
	}

	return result;
}

// ============================================================================
// Lease Expiry
// ============================================================================

/** Calculate the lease expiration timestamp. */
export function leaseExpiresAt(durationSeconds: number = LEASE_DURATION_SECONDS): Date {
	return new Date(Date.now() + durationSeconds * 1000);
}

// ============================================================================
// Empty Deployment
// ============================================================================

/** Return a valid empty UntypedDeployment (version 3). */
export function emptyDeployment(): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			manifest: {
				time: new Date().toISOString(),
				magic: "",
				version: "",
			},
			resources: [],
		},
	};
}
