// @procella/api — tRPC initialization and context definition.

import type { AuditService } from "@procella/audit";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { GitHubService } from "@procella/github";
import type { TrustPolicyRepository } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { trpcProcedureDuration, withSpan } from "@procella/telemetry";
import { type Caller, ProcellaError, type SubscriptionTicketScope } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { initTRPC, type TRPC_ERROR_CODE_KEY, TRPCError } from "@trpc/server";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import superjson from "superjson";
import type { NotificationHub } from "./notifications.js";

// ============================================================================
// Context
// ============================================================================

export interface TRPCContext {
	caller: Caller | null;
	issueSubscriptionTicket?: (caller: Caller, scope: SubscriptionTicketScope) => Promise<string>;
	setGitHubSetupCookie?: (nonce: string) => void;
	/** Browser-bound setup nonce from the HttpOnly `__Host-` cookie, when present. */
	githubSetupNonce?: string;
	/**
	 * Dashboard origin the Descope outbound callback returns the browser to.
	 * The GitHub connect redirect URL is always built from this trusted,
	 * server-configured origin, never from client input. Absent when the
	 * deployment has no dashboard origin configured.
	 */
	appOrigin?: string;
	/** Descope Outbound Application that vaults each admin's GitHub user token. */
	githubOutboundAppId?: string;
	resolveUserDisplayName: (subject: string) => Promise<string | null>;
	db: Database;
	notifications: NotificationHub;
	stacks: StacksService;
	audit: AuditService;
	updates: UpdatesService;
	webhooks: WebhooksService;
	esc: EscService;
	github: GitHubService | null;
	oidcPolicies?: TrustPolicyRepository | null;
}

// ============================================================================
// tRPC Instance
// ============================================================================

export const trpcTransformer = superjson;

const TRPC_CODE_BY_STATUS: Partial<Record<number, TRPC_ERROR_CODE_KEY>> = {
	400: "BAD_REQUEST",
	401: "UNAUTHORIZED",
	403: "FORBIDDEN",
	404: "NOT_FOUND",
	409: "CONFLICT",
	422: "UNPROCESSABLE_CONTENT",
};

const t = initTRPC.context<TRPCContext>().create({
	transformer: trpcTransformer,
	errorFormatter({ error, shape }) {
		const domainError = error.cause instanceof ProcellaError ? error.cause : undefined;
		let code: TRPC_ERROR_CODE_KEY = error.code;
		let httpStatus = shape.data.httpStatus;

		if (domainError) {
			code = TRPC_CODE_BY_STATUS[domainError.statusCode] ?? "INTERNAL_SERVER_ERROR";
			httpStatus = code === "INTERNAL_SERVER_ERROR" ? 500 : domainError.statusCode;
		}

		const { stack: _stack, ...data } = shape.data;
		if (httpStatus >= 400 && httpStatus < 500) {
			return {
				...shape,
				message: domainError?.message ?? shape.message,
				code: TRPC_ERROR_CODES_BY_KEY[code],
				data: { ...data, code, httpStatus },
			};
		}
		return {
			...shape,
			message: "Internal server error",
			code: TRPC_ERROR_CODES_BY_KEY[code],
			data: { ...data, code, httpStatus },
		};
	},
});

const tracingMiddleware = t.middleware(async (ctx) => {
	const start = performance.now();

	return withSpan(
		"procella.trpc",
		`trpc.${ctx.path ?? "unknown"}`,
		{ "trpc.type": ctx.type },
		async () => {
			try {
				return await ctx.next();
			} finally {
				trpcProcedureDuration().record(performance.now() - start, {
					"trpc.procedure": ctx.path ?? "unknown",
					"trpc.type": ctx.type,
				});
			}
		},
	);
});

const protectedMiddleware = t.middleware(async ({ ctx, next }) => {
	if (!ctx.caller) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
	}

	return next({
		ctx: {
			...ctx,
			caller: ctx.caller,
			setGitHubSetupCookie: ctx.setGitHubSetupCookie,
			githubSetupNonce: ctx.githubSetupNonce,
		},
	});
});

const memberMiddleware = t.middleware(async ({ ctx, next }) => {
	if (!ctx.caller) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
	}

	if (!ctx.caller.roles.some((role) => role === "member" || role === "admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Member role required" });
	}

	return next({
		ctx: {
			...ctx,
			caller: ctx.caller,
			setGitHubSetupCookie: ctx.setGitHubSetupCookie,
			githubSetupNonce: ctx.githubSetupNonce,
		},
	});
});

const adminMiddleware = t.middleware(async ({ ctx, next }) => {
	if (!ctx.caller) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
	}

	if (!ctx.caller.roles.includes("admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
	}

	return next({
		ctx: {
			...ctx,
			caller: ctx.caller,
			setGitHubSetupCookie: ctx.setGitHubSetupCookie,
			githubSetupNonce: ctx.githubSetupNonce,
		},
	});
});

// Keep bare t.procedure usage confined to this file.
const instrumentedProcedure = t.procedure.use(tracingMiddleware);

export const router = t.router;
export const publicProcedure = instrumentedProcedure;
export const protectedProcedure = instrumentedProcedure.use(protectedMiddleware);
export const memberProcedure = instrumentedProcedure.use(memberMiddleware);
export const adminProcedure = instrumentedProcedure.use(adminMiddleware);
