import { ProcellaError } from "@procella/types";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../logger.js";

export function errorHandler(): ErrorHandler {
	return (error, c) => {
		if (error instanceof ProcellaError) {
			return c.json(
				{ code: error.statusCode, message: error.message },
				error.statusCode as ContentfulStatusCode,
			);
		}
		logger.error({ err: error }, "Unhandled error");
		return c.json({ code: 500, message: "Internal server error" }, 500);
	};
}
