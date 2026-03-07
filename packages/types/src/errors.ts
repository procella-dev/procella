// @strata/types — Domain error classes.

// ============================================================================
// Base Error
// ============================================================================

export class StrataError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number,
	) {
		super(message);
		this.name = "StrataError";
	}
}

// ============================================================================
// HTTP Status Errors
// ============================================================================

export class NotFoundError extends StrataError {
	constructor(resource: string, id: string) {
		super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
		this.name = "NotFoundError";
	}
}

export class ConflictError extends StrataError {
	constructor(message: string) {
		super(message, "CONFLICT", 409);
		this.name = "ConflictError";
	}
}

export class BadRequestError extends StrataError {
	constructor(message: string) {
		super(message, "BAD_REQUEST", 400);
		this.name = "BadRequestError";
	}
}

export class UnauthorizedError extends StrataError {
	constructor(message?: string) {
		super(message ?? "Unauthorized", "UNAUTHORIZED", 401);
		this.name = "UnauthorizedError";
	}
}

export class ForbiddenError extends StrataError {
	constructor(message?: string) {
		super(message ?? "Forbidden", "FORBIDDEN", 403);
		this.name = "ForbiddenError";
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

export class StackAlreadyExistsError extends ConflictError {
	constructor(org: string, project: string, stack: string) {
		super(`Stack already exists: ${org}/${project}/${stack}`);
		this.name = "StackAlreadyExistsError";
	}
}

export class StackHasResourcesError extends ConflictError {
	constructor(org: string, project: string, stack: string) {
		super(`Stack has resources and cannot be deleted without --force: ${org}/${project}/${stack}`);
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
