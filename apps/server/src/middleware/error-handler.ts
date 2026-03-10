// @procella/server — Global error handler.

import { ProcellaError } from "@procella/types";
import type { ErrorHandler } from "hono";

/** Catch errors and return structured JSON responses. Used with app.onError(). */
export function errorHandler(): ErrorHandler {
	return (error, c) => {
		if (error instanceof ProcellaError) {
			return c.json({ code: error.statusCode, message: error.message }, error.statusCode as 500);
		}
		// biome-ignore lint/suspicious/noConsole: server error logging
		console.error("Unhandled error:", error);
		return c.json({ code: 500, message: "Internal server error" }, 500);
	};
}
