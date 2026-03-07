// @strata/server — PulumiAccept header validation middleware.

import type { MiddlewareHandler } from "hono";

const REQUIRED_ACCEPT = "application/vnd.pulumi+8";

/** Require the Accept header to contain "application/vnd.pulumi+8". */
export function pulumiAccept(): MiddlewareHandler {
	return async (c, next) => {
		const accept = c.req.header("Accept");
		if (!accept || !accept.includes(REQUIRED_ACCEPT)) {
			return c.json(
				{
					code: 415,
					message: `Missing required Accept header: ${REQUIRED_ACCEPT}`,
				},
				415,
			);
		}
		await next();
	};
}
