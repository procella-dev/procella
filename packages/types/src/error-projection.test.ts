import { describe, expect, test } from "bun:test";
import { projectError } from "./error-projection.js";

const SECRET = "m6-canary-database-password";

function drizzleError() {
	const error = Object.assign(
		new Error(`Failed query: insert into credentials (value) values ($1)\nparams: ${SECRET}`),
		{
			query: "insert into credentials (value) values ($1)",
			params: [SECRET],
			cause: Object.assign(new Error(`password authentication failed for ${SECRET}`), {
				code: "23505",
			}),
		},
	);
	error.stack = `${error.message}\n    at executeQuery (/app/db.ts:10:2)\nCaused by: ${SECRET}`;
	return error;
}

describe("projectError", () => {
	test("removes database query fields, causes, and stack messages", () => {
		const projected = projectError(drizzleError());
		const serialized = JSON.stringify(projected);

		expect(projected.message).toBe("Database query failed");
		expect(projected.code).toBe("23505");
		expect(projected.stack).toBe(
			"Error: Database query failed\n    at executeQuery (/app/db.ts:10:2)",
		);
		expect(projected).not.toHaveProperty("query");
		expect(projected).not.toHaveProperty("params");
		expect(projected).not.toHaveProperty("cause");
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("insert into credentials");
	});

	test("redacts a database error nested inside a wrapper cause", () => {
		const wrapper = new Error(`Request failed: ${SECRET}`, { cause: drizzleError() });
		const projected = projectError(wrapper);

		expect(projected.message).toBe("Database query failed");
		expect(JSON.stringify(projected)).not.toContain(SECRET);
	});

	test("preserves ordinary error messages and stack frames", () => {
		const error = new Error("ordinary failure");
		error.stack = "Error: ordinary failure\n    at run (/app/service.ts:20:4)";

		expect(projectError(error)).toEqual({
			type: "Error",
			name: "Error",
			message: "ordinary failure",
			stack: "Error: ordinary failure\n    at run (/app/service.ts:20:4)",
		});
	});
});
