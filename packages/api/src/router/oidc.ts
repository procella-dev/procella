// @procella/api — OIDC trust policy management router.

import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

// ============================================================================
// Guard
// ============================================================================

function assertAdmin(roles: readonly string[]): void {
	if (!roles.includes("admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
	}
}

function assertOidc(ctx: { oidcPolicies?: unknown }): void {
	if (!ctx.oidcPolicies) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "OIDC is not enabled on this server",
		});
	}
}

// ============================================================================
// Input schemas
// ============================================================================

const createPolicyInput = z.object({
	provider: z.literal("github-actions"),
	displayName: z.string().min(1).max(100),
	issuer: z
		.string()
		.url()
		.refine(
			(u) =>
				u.startsWith("https://") ||
				u.startsWith("http://localhost") ||
				u.startsWith("http://127.0.0.1"),
			{
				message:
					"Issuer URL must use HTTPS (http://localhost and http://127.0.0.1 are allowed for testing)",
			},
		),
	maxExpiration: z.number().int().min(60).max(86400).default(7200),
	claimConditions: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0, {
		message: "At least one claim condition is required to prevent unrestricted token acceptance",
	}),
	grantedRole: z.enum(["viewer", "member", "admin"]),
});

const updatePolicyInput = z.object({
	id: z.string().uuid(),
	displayName: z.string().min(1).max(100).optional(),
	maxExpiration: z.number().int().min(60).max(86400).optional(),
	claimConditions: z
		.record(z.string(), z.string())
		.refine((v) => Object.keys(v).length > 0, {
			message: "At least one claim condition is required to prevent unrestricted token acceptance",
		})
		.optional(),
	grantedRole: z.enum(["viewer", "member", "admin"]).optional(),
	active: z.boolean().optional(),
});

// ============================================================================
// Router
// ============================================================================

export const oidcRouter = router({
	listPolicies: publicProcedure.query(async ({ ctx }) => {
		assertAdmin(ctx.caller.roles);
		assertOidc(ctx);
		// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
		return ctx.oidcPolicies!.listByOrgSlug(ctx.caller.orgSlug, ctx.caller.tenantId);
	}),

	createPolicy: publicProcedure.input(createPolicyInput).mutation(async ({ ctx, input }) => {
		assertAdmin(ctx.caller.roles);
		assertOidc(ctx);
		// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
		return ctx.oidcPolicies!.create({
			tenantId: ctx.caller.tenantId,
			orgSlug: ctx.caller.orgSlug,
			provider: input.provider,
			displayName: input.displayName,
			issuer: input.issuer,
			maxExpiration: input.maxExpiration,
			claimConditions: input.claimConditions,
			grantedRole: input.grantedRole,
			active: true,
		});
	}),

	updatePolicy: publicProcedure.input(updatePolicyInput).mutation(async ({ ctx, input }) => {
		assertAdmin(ctx.caller.roles);
		assertOidc(ctx);
		const { id, ...patch } = input;
		// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
		return ctx.oidcPolicies!.update(id, ctx.caller.tenantId, patch);
	}),

	deletePolicy: publicProcedure
		.input(z.object({ id: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			assertAdmin(ctx.caller.roles);
			assertOidc(ctx);
			// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
			await ctx.oidcPolicies!.delete(input.id, ctx.caller.tenantId);
			return { success: true };
		}),
});
