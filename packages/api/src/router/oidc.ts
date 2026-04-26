// @procella/api — OIDC trust policy management router.

import {
	OidcPolicyClaimConditionsError,
	OidcPolicyConflictError,
	validateTrustPolicyClaimConditions,
} from "@procella/oidc";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function addClaimConditionValidationIssue(
	input: {
		provider: string;
		issuer: string;
		claimConditions: Record<string, string>;
	},
	ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
	try {
		validateTrustPolicyClaimConditions(input);
	} catch (error) {
		if (error instanceof OidcPolicyClaimConditionsError) {
			ctx.addIssue({
				code: "custom",
				path: ["claimConditions"],
				message: error.message,
			});
			return;
		}
		throw error;
	}
}

function rethrowOidcPolicyError(error: unknown): never {
	if (error instanceof OidcPolicyConflictError) {
		throw new TRPCError({ code: "CONFLICT", message: error.message, cause: error });
	}
	if (error instanceof OidcPolicyClaimConditionsError) {
		throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
	}
	throw error;
}

// ============================================================================
// Input schemas
// ============================================================================

const createPolicyInput = z
	.object({
		provider: z.literal("github-actions"),
		displayName: z.string().min(1).max(100),
		issuer: z.string().refine(
			(value) => {
				try {
					const url = new URL(value);
					return (
						url.protocol === "https:" ||
						(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
					);
				} catch {
					return false;
				}
			},
			{
				message:
					"Issuer URL must use HTTPS (http://localhost and http://127.0.0.1 are allowed for testing)",
			},
		),
		maxExpiration: z.number().int().min(60).max(86400).default(7200),
		claimConditions: z.record(z.string(), z.string()),
		grantedRole: z.enum(["viewer", "member", "admin"]),
	})
	.superRefine((input, ctx) => addClaimConditionValidationIssue(input, ctx));

const updatePolicyInput = z.object({
	id: z.string().refine((value) => UUID_V4_PATTERN.test(value), { message: "Invalid UUID" }),
	displayName: z.string().min(1).max(100).optional(),
	maxExpiration: z.number().int().min(60).max(86400).optional(),
	claimConditions: z.record(z.string(), z.string()).optional(),
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
		try {
			// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
			return await ctx.oidcPolicies!.create({
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
		} catch (error) {
			rethrowOidcPolicyError(error);
		}
	}),

	updatePolicy: publicProcedure.input(updatePolicyInput).mutation(async ({ ctx, input }) => {
		assertAdmin(ctx.caller.roles);
		assertOidc(ctx);
		const { id, ...patch } = input;
		try {
			// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
			return await ctx.oidcPolicies!.update(id, ctx.caller.tenantId, patch);
		} catch (error) {
			rethrowOidcPolicyError(error);
		}
	}),

	deletePolicy: publicProcedure
		.input(
			z.object({
				id: z.string().refine((value) => UUID_V4_PATTERN.test(value), {
					message: "Invalid UUID",
				}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertAdmin(ctx.caller.roles);
			assertOidc(ctx);
			// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
			await ctx.oidcPolicies!.delete(input.id, ctx.caller.tenantId);
			return { success: true };
		}),
});
