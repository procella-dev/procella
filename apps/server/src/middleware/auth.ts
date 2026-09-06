// @procella/server — Auth middleware (API token + update-token).

import type { AuthService } from "@procella/auth";
import { requireRole } from "@procella/auth";
import type { StacksService } from "@procella/stacks";
import type { Caller, Role } from "@procella/types";
import { ProcellaError } from "@procella/types";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types.js";

// ============================================================================
// API Token Auth
// ============================================================================

/** Authenticate using the credentials supported by the configured auth service. */
export function apiAuth(authService: AuthService): MiddlewareHandler<Env> {
	return async (c, next) => {
		try {
			const caller: Caller = await authService.authenticate(c.req.raw);

			c.set("caller", caller);
			await next();
		} catch (error) {
			if (error instanceof ProcellaError) {
				return c.json(
					{ code: error.statusCode, message: error.message },
					error.statusCode as ContentfulStatusCode,
				);
			}
			return c.json({ code: 401, message: "Unauthorized" }, 401);
		}
	};
}

// ============================================================================
// Update Token Auth
// ============================================================================

export type LeaseTokenVerifier = (updateId: string, token: string) => Promise<void>;

export function updateAuth(
	authService: AuthService,
	verifyLeaseToken: LeaseTokenVerifier,
	stacks: Pick<StacksService, "getStackById_systemOnly">,
): MiddlewareHandler<Env> {
	return async (c, next) => {
		try {
			const header = c.req.header("Authorization");
			if (!header?.startsWith("update-token ")) {
				return c.json({ code: 401, message: "Missing update-token Authorization" }, 401);
			}
			const token = header.slice("update-token ".length).trim();
			if (!token) {
				return c.json({ code: 401, message: "Empty update-token" }, 401);
			}
			const ctx = await authService.authenticateUpdateToken(token);
			await verifyLeaseToken(ctx.updateId, token);

			const project = c.req.param("project");
			const stack = c.req.param("stack");
			if (project && stack) {
				// Look up by trusted stackId from the lease token (UUID PK), then verify
				// the URL project+stack names match. We deliberately do NOT compare the
				// URL `org` slug because in OIDC mode the URL slug is the human-readable
				// orgSlug while `projects.tenantId` is a Descope UUID — they diverge.
				// The lease token is cryptographically bound to `stackId`, so trusting it
				// for the lookup and verifying the URL names is sufficient. (procella-64t)
				const stackInfo = await stacks.getStackById_systemOnly(ctx.stackId);
				if (stackInfo.projectName !== project || stackInfo.stackName !== stack) {
					return c.json(
						{
							code: "lease_url_mismatch",
							message: "Lease token does not match URL stack",
						},
						403,
					);
				}
			}

			c.set("updateContext", ctx);
			await next();
		} catch (error) {
			if (error instanceof ProcellaError) {
				return c.json(
					{ code: error.statusCode, message: error.message },
					error.statusCode as ContentfulStatusCode,
				);
			}
			return c.json({ code: 401, message: "Unauthorized" }, 401);
		}
	};
}

// ============================================================================
// Role Check
// ============================================================================

/** Require the caller to have one of the specified roles. */
export function requireRoleMiddleware(...roles: Role[]): MiddlewareHandler<Env> {
	return async (c, next) => {
		try {
			const caller = c.get("caller");
			requireRole(caller, ...roles);
			await next();
		} catch (error) {
			if (error instanceof ProcellaError) {
				return c.json(
					{ code: error.statusCode, message: error.message },
					error.statusCode as ContentfulStatusCode,
				);
			}
			return c.json({ code: 403, message: "Forbidden" }, 403);
		}
	};
}
