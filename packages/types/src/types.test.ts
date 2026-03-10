import { describe, expect, test } from "bun:test";
import {
	ErrorType,
	formatStackFQN,
	NotFoundError,
	ProcellaError,
	parseStackFQN,
	type StackFQN,
	UpdateKind,
	UpdateResult,
	UpdateStatus,
} from "./index.js";

describe("@procella/types", () => {
	describe("StackFQN", () => {
		test("parseStackFQN splits org/project/stack", () => {
			const fqn = parseStackFQN("acme/my-project/production");
			expect(fqn).toEqual({
				org: "acme",
				project: "my-project",
				stack: "production",
			});
		});

		test("formatStackFQN joins with slashes", () => {
			const fqn: StackFQN = {
				org: "acme",
				project: "my-project",
				stack: "dev",
			};
			expect(formatStackFQN(fqn)).toBe("acme/my-project/dev");
		});
	});

	describe("errors", () => {
		test("ProcellaError has correct name and status", () => {
			const err = new ProcellaError("test error", "TEST", 400);
			expect(err.name).toBe("ProcellaError");
			expect(err.statusCode).toBe(400);
			expect(err.code).toBe("TEST");
			expect(err.message).toBe("test error");
			expect(err).toBeInstanceOf(Error);
		});

		test("NotFoundError defaults to 404", () => {
			const err = new NotFoundError("stack", "abc-123");
			expect(err.statusCode).toBe(404);
			expect(err.code).toBe("NOT_FOUND");
			expect(err).toBeInstanceOf(ProcellaError);
		});
	});

	describe("enum objects", () => {
		test("UpdateKind has all expected values", () => {
			expect(UpdateKind.Update).toBe("update");
			expect(UpdateKind.Preview).toBe("preview");
			expect(UpdateKind.Refresh).toBe("refresh");
			expect(UpdateKind.Destroy).toBe("destroy");
			expect(UpdateKind.Import).toBe("import");
		});

		test("UpdateResult has all expected values", () => {
			expect(UpdateResult.Succeeded).toBe("succeeded");
			expect(UpdateResult.Failed).toBe("failed");
			expect(UpdateResult.InProgress).toBe("in-progress");
			expect(UpdateResult.NotStarted).toBe("not-started");
		});

		test("UpdateStatus has all expected values", () => {
			expect(UpdateStatus.Running).toBe("running");
			expect(UpdateStatus.Succeeded).toBe("succeeded");
			expect(UpdateStatus.Failed).toBe("failed");
			expect(UpdateStatus.Cancelled).toBe("cancelled");
			expect(UpdateStatus.NotStarted).toBe("not started");
			expect(UpdateStatus.Requested).toBe("requested");
		});

		test("ErrorType has all expected values", () => {
			expect(ErrorType.NotFound).toBe("not_found");
			expect(ErrorType.AlreadyExists).toBe("already_exists");
			expect(ErrorType.Invalid).toBe("invalid");
		});
	});
});
