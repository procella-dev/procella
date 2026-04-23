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

/** Output the CLI and dashboard receive from /open. Secrets are masked. */
export interface OpenSessionResult {
	sessionId: string;
	values: Record<string, unknown>;
	/** JSON paths (dot-delimited) of values flagged secret by the evaluator. */
	secrets: string[];
	expiresAt: Date;
}
