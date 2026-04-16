// @procella/server — Auth middleware (API token + update-token).

import type { AuthService } from "@procella/auth";
import { requireRole } from "@procella/auth";
import type { Caller, Role } from "@procella/types";
import { ProcellaError, UnauthorizedError } from "@procella/types";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../types.js";

// ============================================================================
// API Token Auth
// ============================================================================

/** Authenticate using "Authorization: token <value>" or "Bearer <value>". */
export function apiAuth(authService: AuthService): MiddlewareHandler<Env> {
	return async (c, next) => {
		try {
			extractTokenValue(c.req.raw);
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

function extractTokenValue(request: Request): string {
	const header = request.headers.get("Authorization");
	if (!header) {
		throw new UnauthorizedError("Missing Authorization header");
	}

	if (header.startsWith("token ")) {
		const value = header.slice(6).trim();
		if (!value) {
			throw new UnauthorizedError("Empty token value");
		}
		return value;
	}

	if (header.startsWith("Bearer ")) {
		const value = header.slice(7).trim();
		if (!value) {
			throw new UnauthorizedError("Empty Bearer token");
		}
		return value;
	}

	throw new UnauthorizedError("Invalid Authorization header format");
}

// ============================================================================
// Update Token Auth
// ============================================================================

export type LeaseTokenVerifier = (updateId: string, token: string) => Promise<void>;

export function updateAuth(
	authService: AuthService,
	verifyLeaseToken: LeaseTokenVerifier,
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
