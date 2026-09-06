// @procella/types — Domain error classes.

// ============================================================================
// Base Error
// ============================================================================

export class ProcellaError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number,
	) {
		super(message);
		this.name = "ProcellaError";
	}
}

// ============================================================================
// HTTP Status Errors
// ============================================================================

export class NotFoundError extends ProcellaError {
	constructor(resource: string, id: string) {
		super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
		this.name = "NotFoundError";
	}
}

export class ConflictError extends ProcellaError {
	constructor(message: string) {
		super(message, "CONFLICT", 409);
		this.name = "ConflictError";
	}
}

export class BadRequestError extends ProcellaError {
	constructor(message: string) {
		super(message, "BAD_REQUEST", 400);
		this.name = "BadRequestError";
	}
}

export class UnauthorizedError extends ProcellaError {
	constructor(message?: string) {
		super(message ?? "Unauthorized", "UNAUTHORIZED", 401);
		this.name = "UnauthorizedError";
	}
}

export class ForbiddenError extends ProcellaError {
	constructor(message?: string) {
		super(message ?? "Forbidden", "FORBIDDEN", 403);
		this.name = "ForbiddenError";
	}
}

// ============================================================================
// Name Validation Errors
// ============================================================================

export class InvalidNameError extends BadRequestError {
	constructor(message: string) {
		super(message);
		this.name = "InvalidNameError";
	}
}

// ============================================================================
// Stack Errors
// ============================================================================

export class StackNotFoundError extends NotFoundError {
	constructor(org: string, project: string, stack: string) {
		super("Stack", `${org}/${project}/${stack}`);
		this.name = "StackNotFoundError";
	}
}

export class StackNotFoundByIdError extends NotFoundError {
	constructor(stackId: string) {
		super("Stack", `id=${stackId}`);
		this.name = "StackNotFoundByIdError";
	}
}

export class StackAlreadyExistsError extends ConflictError {
	constructor(org: string, project: string, stack: string) {
		super(`Stack already exists: ${org}/${project}/${stack}`);
		this.name = "StackAlreadyExistsError";
	}
}

/**
 * Rejection for `DELETE /api/stacks/:org/:project/:stack` without `?force=true`
 * on a stack that still holds resources.
 *
 * The status/message pair is a wire contract, not a cosmetic string: the Pulumi
 * CLI only prints its "still has resources; removal rejected; pass --force to
 * override" hint when the response is exactly HTTP 400 with this message
 * (`isStackHasResourcesError` in pkg/backend/httpstate/client/client.go).
 * Do not reword.
 */
export class StackHasResourcesError extends BadRequestError {
	constructor() {
		super("Bad Request: Stack still contains resources.");
		this.name = "StackHasResourcesError";
	}
}

// ============================================================================
// Update Errors
// ============================================================================

export class UpdateNotFoundError extends NotFoundError {
	constructor(updateId: string) {
		super("Update", updateId);
		this.name = "UpdateNotFoundError";
	}
}

export class UpdateConflictError extends ConflictError {
	constructor(message: string) {
		super(message);
		this.name = "UpdateConflictError";
	}
}

export class LeaseExpiredError extends UnauthorizedError {
	constructor() {
		super("Update lease has expired");
		this.name = "LeaseExpiredError";
	}
}

export class InvalidUpdateTokenError extends UnauthorizedError {
	constructor() {
		super("Invalid update token");
		this.name = "InvalidUpdateTokenError";
	}
}

// ============================================================================
// Project Errors
// ============================================================================

export class ProjectNotFoundError extends NotFoundError {
	constructor(org: string, project: string) {
		super("Project", `${org}/${project}`);
		this.name = "ProjectNotFoundError";
	}
}

// ============================================================================
// Checkpoint Errors
// ============================================================================

export class CheckpointNotFoundError extends NotFoundError {
	constructor(org: string, project: string, stack: string) {
		super("Checkpoint", `${org}/${project}/${stack}`);
		this.name = "CheckpointNotFoundError";
	}
}
