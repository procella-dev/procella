// @procella/esc — Domain types for environments, revisions, and sessions.

export interface EscProject {
	id: string;
	tenantId: string;
	name: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface EscEnvironment {
	id: string;
	projectId: string;
	name: string;
	yamlBody: string;
	currentRevisionNumber: number;
	createdBy: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface EscEnvironmentRevision {
	id: string;
	environmentId: string;
	revisionNumber: number;
	yamlBody: string;
	createdBy: string;
	createdAt: Date;
}

/**
 * Materialized output of a single `open` call. Stored encrypted in
 * `esc_sessions`. Fetched via GET /open/{sessionId} before TTL expiry.
 */
export interface EscSession {
	id: string;
	environmentId: string;
	revisionId: string;
	/** Base64-encoded AES-256-GCM ciphertext of resolved values JSON. */
	resolvedValuesCiphertext: string;
	openedAt: Date;
	expiresAt: Date;
	closedAt: Date | null;
}

export interface CreateEnvironmentInput {
	projectName: string;
	name: string;
	yamlBody: string;
}

export interface UpdateEnvironmentInput {
	yamlBody: string;
}

export interface EscRevisionTag {
	name: string;
	revisionNumber: number;
	createdBy: string;
	createdAt: Date;
}

export type DraftStatus = "open" | "applied" | "discarded";

export interface EscDraft {
	id: string;
	environmentId: string;
	yamlBody: string;
	description: string;
	createdBy: string;
	status: DraftStatus;
	appliedRevisionId: string | null;
	appliedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Output the CLI and dashboard receive from /open. Values include resolved
 * plaintext for everything (including secrets); the `secrets` array lists
 * the JSON paths flagged sensitive so clients can mask them at render time.
 */
export interface OpenSessionResult {
	sessionId: string;
	values: Record<string, unknown>;
	/** JSON paths (dot-delimited) of values flagged secret by the evaluator. */
	secrets: string[];
	expiresAt: Date;
}
