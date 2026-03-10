// @procella/server — Request logging middleware.

import type { MiddlewareHandler } from "hono";

/** Log HTTP requests with method, path, status, and duration. */
export function requestLogger(): MiddlewareHandler {
	return async (c, next) => {
		const start = performance.now();
		await next();
		const duration = Math.round(performance.now() - start);
		// biome-ignore lint/suspicious/noConsole: server request logging
		console.info(`[HTTP] ${c.req.method} ${c.req.path} ${c.res.status} ${duration}ms`);
	};
}
