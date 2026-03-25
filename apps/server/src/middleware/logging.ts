import type { MiddlewareHandler } from "hono";
import { logger } from "../logger.js";

export function requestLogger(): MiddlewareHandler {
	return async (c, next) => {
		const start = performance.now();
		await next();
		const duration = Math.round(performance.now() - start);
		const status = c.res.status;
		const data = { method: c.req.method, path: c.req.path, status, duration };
		if (status >= 500) {
			logger.error(data, "request");
		} else if (status >= 400) {
			logger.warn(data, "request");
		} else {
			logger.info(data, "request");
		}
	};
}
