import { describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import type { DestinationStream } from "pino";
import { createLogger } from "./logger.js";

const SECRET = "m6-canary-logger-secret";
const QUERY_FRAME_SECRET = "m6-query-frame-secret";
const PARAM_FRAME_SECRET = "m6-param-frame-secret";

describe("server logger", () => {
	test("does not serialize Drizzle query parameters or causes", () => {
		let output = "";
		const destination: DestinationStream = {
			write(chunk) {
				output += chunk;
			},
		};
		const testLogger = createLogger(destination, "info");
		const error = new DrizzleQueryError(
			`insert into credentials (value) values ($1)\n    at ${QUERY_FRAME_SECRET}`,
			[`${SECRET}\n    at ${PARAM_FRAME_SECRET}`],
			new Error(`database rejected ${SECRET}`),
		);

		testLogger.error({ err: error }, "database operation failed");

		const record = JSON.parse(output) as Record<string, unknown>;
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("insert into credentials");
		expect(serialized).not.toContain(QUERY_FRAME_SECRET);
		expect(serialized).not.toContain(PARAM_FRAME_SECRET);
		expect(record.err).toMatchObject({
			type: "DrizzleQueryError",
			name: "Error",
			message: "Database query failed",
		});
		expect(record.err).not.toHaveProperty("stack");
		expect(record.err).not.toHaveProperty("query");
		expect(record.err).not.toHaveProperty("params");
		expect(record.err).not.toHaveProperty("cause");
	});
});
