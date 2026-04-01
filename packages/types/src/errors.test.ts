import { describe, expect, test } from "bun:test";
import {
	BadRequestError,
	CheckpointNotFoundError,
	ConflictError,
	ForbiddenError,
	InvalidUpdateTokenError,
	LeaseExpiredError,
	NotFoundError,
	ProcellaError,
	ProjectNotFoundError,
	StackAlreadyExistsError,
	StackHasResourcesError,
	StackNotFoundError,
	UnauthorizedError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "./errors.js";

describe("@procella/types errors", () => {
	// ========================================================================
	// ProcellaError (base)
	// ========================================================================

	describe("ProcellaError", () => {
		test("sets message, code, and statusCode", () => {
			const err = new ProcellaError("test", "TEST_CODE", 418);
			expect(err.message).toBe("test");
			expect(err.code).toBe("TEST_CODE");
			expect(err.statusCode).toBe(418);
			expect(err.name).toBe("ProcellaError");
		});

		test("is an instance of Error", () => {
			const err = new ProcellaError("test", "CODE", 500);
			expect(err).toBeInstanceOf(Error);
		});
	});

	// ========================================================================
	// HTTP Status Errors
	// ========================================================================

	describe("NotFoundError", () => {
		test("has 404 status and NOT_FOUND code", () => {
			const err = new NotFoundError("Stack", "org/proj/dev");
			expect(err.statusCode).toBe(404);
			expect(err.code).toBe("NOT_FOUND");
			expect(err.message).toContain("org/proj/dev");
			expect(err.name).toBe("NotFoundError");
		});

		test("is instance of ProcellaError", () => {
			expect(new NotFoundError("X", "1")).toBeInstanceOf(ProcellaError);
		});
	});

	describe("ConflictError", () => {
		test("has 409 status and CONFLICT code", () => {
			const err = new ConflictError("already exists");
			expect(err.statusCode).toBe(409);
			expect(err.code).toBe("CONFLICT");
			expect(err.name).toBe("ConflictError");
		});
	});

	describe("BadRequestError", () => {
		test("has 400 status and BAD_REQUEST code", () => {
			const err = new BadRequestError("invalid input");
			expect(err.statusCode).toBe(400);
			expect(err.code).toBe("BAD_REQUEST");
			expect(err.name).toBe("BadRequestError");
		});
	});

	describe("UnauthorizedError", () => {
		test("has 401 status with default message", () => {
			const err = new UnauthorizedError();
			expect(err.statusCode).toBe(401);
			expect(err.message).toBe("Unauthorized");
			expect(err.name).toBe("UnauthorizedError");
		});

		test("accepts custom message", () => {
			const err = new UnauthorizedError("bad token");
			expect(err.message).toBe("bad token");
		});
	});

	describe("ForbiddenError", () => {
		test("has 403 status with default message", () => {
			const err = new ForbiddenError();
			expect(err.statusCode).toBe(403);
			expect(err.message).toBe("Forbidden");
			expect(err.name).toBe("ForbiddenError");
		});

		test("accepts custom message", () => {
			const err = new ForbiddenError("no access");
			expect(err.message).toBe("no access");
		});
	});

	// ========================================================================
	// Stack Errors
	// ========================================================================

	describe("StackNotFoundError", () => {
		test("has 404 status with org/project/stack in message", () => {
			const err = new StackNotFoundError("myorg", "myproj", "dev");
			expect(err.statusCode).toBe(404);
			expect(err.message).toContain("myorg/myproj/dev");
			expect(err.name).toBe("StackNotFoundError");
		});

		test("is instance of NotFoundError and ProcellaError", () => {
			const err = new StackNotFoundError("o", "p", "s");
			expect(err).toBeInstanceOf(NotFoundError);
			expect(err).toBeInstanceOf(ProcellaError);
		});
	});

	describe("StackAlreadyExistsError", () => {
		test("has 409 status", () => {
			const err = new StackAlreadyExistsError("org", "proj", "dev");
			expect(err.statusCode).toBe(409);
			expect(err.message).toContain("org/proj/dev");
			expect(err.name).toBe("StackAlreadyExistsError");
		});

		test("is instance of ConflictError", () => {
			expect(new StackAlreadyExistsError("o", "p", "s")).toBeInstanceOf(ConflictError);
		});
	});

	describe("StackHasResourcesError", () => {
		test("has 409 status with --force hint", () => {
			const err = new StackHasResourcesError("org", "proj", "dev");
			expect(err.statusCode).toBe(409);
			expect(err.message).toContain("--force");
			expect(err.name).toBe("StackHasResourcesError");
		});
	});

	// ========================================================================
	// Update Errors
	// ========================================================================

	describe("UpdateNotFoundError", () => {
		test("has 404 status with update ID", () => {
			const err = new UpdateNotFoundError("upd-123");
			expect(err.statusCode).toBe(404);
			expect(err.message).toContain("upd-123");
			expect(err.name).toBe("UpdateNotFoundError");
		});
	});

	describe("UpdateConflictError", () => {
		test("has 409 status", () => {
			const err = new UpdateConflictError("active update");
			expect(err.statusCode).toBe(409);
			expect(err.name).toBe("UpdateConflictError");
		});
	});

	describe("LeaseExpiredError", () => {
		test("has 401 status with fixed message", () => {
			const err = new LeaseExpiredError();
			expect(err.statusCode).toBe(401);
			expect(err.message).toContain("expired");
			expect(err.name).toBe("LeaseExpiredError");
		});

		test("is instance of UnauthorizedError", () => {
			expect(new LeaseExpiredError()).toBeInstanceOf(UnauthorizedError);
		});
	});

	describe("InvalidUpdateTokenError", () => {
		test("has 401 status with fixed message", () => {
			const err = new InvalidUpdateTokenError();
			expect(err.statusCode).toBe(401);
			expect(err.message).toContain("Invalid update token");
			expect(err.name).toBe("InvalidUpdateTokenError");
		});
	});

	// ========================================================================
	// Project + Checkpoint Errors
	// ========================================================================

	describe("ProjectNotFoundError", () => {
		test("has 404 status with org/project", () => {
			const err = new ProjectNotFoundError("myorg", "myproj");
			expect(err.statusCode).toBe(404);
			expect(err.message).toContain("myorg/myproj");
			expect(err.name).toBe("ProjectNotFoundError");
		});
	});

	describe("CheckpointNotFoundError", () => {
		test("has 404 status with stack path", () => {
			const err = new CheckpointNotFoundError("org", "proj", "dev");
			expect(err.statusCode).toBe(404);
			expect(err.message).toContain("org/proj/dev");
			expect(err.name).toBe("CheckpointNotFoundError");
		});
	});

	// ========================================================================
	// Inheritance chain
	// ========================================================================

	describe("inheritance", () => {
		test("all errors extend Error", () => {
			const errors = [
				new ProcellaError("x", "x", 500),
				new NotFoundError("x", "x"),
				new ConflictError("x"),
				new BadRequestError("x"),
				new UnauthorizedError(),
				new ForbiddenError(),
				new StackNotFoundError("o", "p", "s"),
				new StackAlreadyExistsError("o", "p", "s"),
				new StackHasResourcesError("o", "p", "s"),
				new UpdateNotFoundError("u"),
				new UpdateConflictError("x"),
				new LeaseExpiredError(),
				new InvalidUpdateTokenError(),
				new ProjectNotFoundError("o", "p"),
				new CheckpointNotFoundError("o", "p", "s"),
			];
			for (const err of errors) {
				expect(err).toBeInstanceOf(Error);
				expect(err).toBeInstanceOf(ProcellaError);
			}
		});
	});
});
