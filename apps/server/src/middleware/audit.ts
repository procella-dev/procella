import {
	type AuditService,
	extractResourceId,
	extractResourceType,
	mapRouteToAction,
} from "@procella/audit";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

export function auditMiddleware(auditService: AuditService): MiddlewareHandler<Env> {
	return async (c, next) => {
		await next();

		if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
			return;
		}
		if (c.res.status >= 400) {
			return;
		}

		const caller = c.get("caller");
		if (!caller) {
			return;
		}

		const action = mapRouteToAction(c.req.method, c.req.path);
		if (!action) {
			return;
		}

		const metadata = caller.workload ? { workload: caller.workload } : undefined;

		void auditService.log(caller.tenantId, {
			actorId: caller.userId,
			actorType:
				caller.principalType === "workload"
					? "workload"
					: caller.userId.startsWith("token:")
						? "token"
						: "user",
			action,
			resourceType: extractResourceType(c.req.path),
			resourceId: extractResourceId(c.req.path),
			ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? undefined,
			userAgent: c.req.header("user-agent") ?? undefined,
			metadata,
		});
	};
}
