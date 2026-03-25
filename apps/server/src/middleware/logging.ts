import type { MiddlewareHandler } from "hono";
import { logger } from "../logger.js";

export function requestLogger(): MiddlewareHandler {
	return async (c, next) => {
		const start = performance.now();
		await next();
		const duration = Math.round(performance.now() - start);
		logger.info(
			{ method: c.req.method, path: c.req.path, status: c.res.status, duration },
			"request",
		);
	};
}
