// @procella/updates — Pure helper functions.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { UntypedDeployment } from "@procella/types";
import { InvalidUpdateTokenError } from "@procella/types";
import { LEASE_DURATION_SECONDS } from "./types.js";

// ============================================================================
// Lease Token
// ============================================================================

/** Generate a cryptographically secure lease token for an active update. */
export function generateLeaseToken(updateId: string, stackId: string): string {
	const secret = randomBytes(32).toString("hex");
	return `update:${updateId}:${stackId}:${secret}`;
}

/** Parse a lease token back into its components. */
export function parseLeaseToken(token: string): { updateId: string; stackId: string } {
	const parts = token.split(":");
	if (parts.length !== 4 || parts[0] !== "update" || !parts[1] || !parts[2] || !parts[3]) {
		throw new InvalidUpdateTokenError();
	}
	return { updateId: parts[1], stackId: parts[2] };
}

/** Constant-time comparison of two lease token strings. */
export function safeTokenCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
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

interface TextEditSpanPoint {
	line: number;
	column: number;
	offset: number;
}

interface TextEditSpan {
	uri?: string;
	start: TextEditSpanPoint;
	end: TextEditSpanPoint;
}

export interface TextEdit {
	span: TextEditSpan;
	newText: string;
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

export function applyTextEdits(before: string, edits: TextEdit[]): string {
	if (edits.length === 0) {
		return before;
	}

	const sorted = [...edits].sort((a, b) => a.span.start.offset - b.span.start.offset);

	let result = "";
	let last = 0;

	for (const edit of sorted) {
		const start = edit.span.start.offset;
		if (start > last) {
			result += before.slice(last, start);
		}
		result += edit.newText;
		last = edit.span.end.offset;
	}

	if (last < before.length) {
		result += before.slice(last);
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
