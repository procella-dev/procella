// @procella/api — tRPC initialization and context definition.

import type { AuditService } from "@procella/audit";
import type { Database } from "@procella/db";
import type { EscService } from "@procella/esc";
import type { GitHubService } from "@procella/github";
import type { TrustPolicyRepository } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { trpcProcedureDuration, withSpan } from "@procella/telemetry";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";

// ============================================================================
// Context
// ============================================================================

export interface TRPCContext {
	caller: Caller;
	db: Database;
	dbUrl: string;
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

const t = initTRPC.context<TRPCContext>().create({
	transformer: superjson,
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

const instrumentedProcedure = t.procedure.use(tracingMiddleware);

export const router = t.router;
export const publicProcedure = instrumentedProcedure;
