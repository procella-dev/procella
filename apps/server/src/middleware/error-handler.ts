import { EscEvaluationError } from "@procella/esc";
import { pgErrorCode } from "@procella/stacks";
import { ProcellaError } from "@procella/types";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../logger.js";

// PostgreSQL transient-conflict SQLSTATE codes — the txn lost a serialization
// race or got picked as a deadlock victim. Both are safe (and expected) to
// retry; mapping them to 503 + Retry-After lets HTTP clients (and the Pulumi
// CLI's built-in 5xx retry) recover instead of seeing them as a 500 outage.
// Tracked under procella-fkf (concurrent checkpoint+event load 5xx flake).
const TRANSIENT_PG_CODES = new Set(["40001", "40P01"]);
const TRANSIENT_RETRY_AFTER_SECONDS = 1;

export function errorHandler(): ErrorHandler {
	return (error, c) => {
		if (error instanceof EscEvaluationError) {
			return c.json(
				{
					code: error.statusCode,
					message: error.message,
					diagnostics: error.diagnostics,
				},
				error.statusCode as ContentfulStatusCode,
			);
		}
		if (error instanceof ProcellaError) {
			return c.json(
				{ code: error.statusCode, message: error.message },
				error.statusCode as ContentfulStatusCode,
			);
		}
		const sqlState = pgErrorCode(error);
		if (sqlState && TRANSIENT_PG_CODES.has(sqlState)) {
			logger.warn(
				{ err: error, sqlState, path: c.req.path, method: c.req.method },
				"transient PG conflict — returning 503 for client retry",
			);
			c.header("Retry-After", String(TRANSIENT_RETRY_AFTER_SECONDS));
			return c.json(
				{
					code: 503,
					error: "transient_conflict",
					message: "Database transaction conflict; retry the request",
					sqlState,
				},
				503,
			);
		}
		logger.error({ err: error }, "Unhandled error");
		return c.json({ code: 500, message: "Internal server error" }, 500);
	};
}
