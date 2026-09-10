// @procella/api — OIDC trust policy management router.

import { type GitHubInstallationRepository, GitHubSetupError } from "@procella/github";
import {
	OidcPolicyClaimConditionsError,
	OidcPolicyConflictError,
	type TrustPolicyRepository,
	validateTrustPolicyClaimConditions,
} from "@procella/oidc";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { adminProcedure, router } from "../trpc.js";

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

function githubRepositoryError(error: unknown): TRPCError {
	if (error instanceof GitHubSetupError) {
		return new TRPCError({
			code: error.code === "repository_lookup_failed" ? "BAD_GATEWAY" : "BAD_REQUEST",
			message:
				error.code === "repository_lookup_failed"
					? "GitHub repositories could not be loaded"
					: "That repository is not available to this GitHub App installation",
		});
	}
	return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unable to configure OIDC" });
}

function assertOidc(ctx: {
	oidcPolicies?: TrustPolicyRepository | null;
}): asserts ctx is { oidcPolicies: TrustPolicyRepository } {
	if (!ctx.oidcPolicies) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "OIDC is not enabled on this server",
		});
	}
}

function requireInteractiveUser(principalType: string): void {
	if (principalType !== "user") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "OIDC setup requires an interactive user session",
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
	listPolicies: adminProcedure.query(async ({ ctx }) => {
		assertOidc(ctx);
		return ctx.oidcPolicies.listByOrgSlug(ctx.caller.orgSlug, ctx.caller.tenantId);
	}),

	status: adminProcedure.query(async ({ ctx }) => {
		if (!ctx.oidcPolicies) {
			return { configured: false as const, githubActionsPolicy: null };
		}
		const policies = await ctx.oidcPolicies.listByOrgSlug(ctx.caller.orgSlug, ctx.caller.tenantId);
		return {
			configured: true as const,
			githubActionsPolicy:
				policies.find(
					(policy) =>
						policy.provider === "github-actions" && policy.issuer === GITHUB_ACTIONS_ISSUER,
				) ?? null,
		};
	}),

	enableGitHubActions: adminProcedure
		.input(
			z.object({
				installationId: z.number().int().positive(),
				repositoryId: z.number().int().positive(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertOidc(ctx);
			if (!ctx.github) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "GitHub App is not configured on this server",
				});
			}
			requireInteractiveUser(ctx.caller.principalType);

			// The global org/issuer key permits only one GitHub Actions policy.
			// Returning the tenant's existing policy makes retries idempotent without
			// silently replacing its repository scope.
			const existing = await ctx.oidcPolicies.findByOrgSlugAndIssuer(
				ctx.caller.orgSlug,
				GITHUB_ACTIONS_ISSUER,
			);
			const owned = existing.find((policy) => policy.tenantId === ctx.caller.tenantId);
			if (owned) return { policy: owned, created: false as const };

			let repositories: GitHubInstallationRepository[];
			try {
				repositories = await ctx.github.listInstallationRepositories(
					ctx.caller.tenantId,
					input.installationId,
				);
			} catch (error) {
				throw githubRepositoryError(error);
			}
			const repository = repositories.find((candidate) => candidate.id === input.repositoryId);
			if (!repository) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "That repository is not available to this GitHub App installation",
				});
			}

			try {
				const policy = await ctx.oidcPolicies.create({
					tenantId: ctx.caller.tenantId,
					orgSlug: ctx.caller.orgSlug,
					provider: "github-actions",
					displayName: `GitHub Actions · ${repository.fullName}`.slice(0, 100),
					issuer: GITHUB_ACTIONS_ISSUER,
					maxExpiration: 7200,
					claimConditions: {
						repository_owner_id: String(repository.ownerId),
						repository_id: String(repository.id),
					},
					grantedRole: "member",
					active: true,
				});
				return { policy, created: true as const };
			} catch (error) {
				if (error instanceof OidcPolicyConflictError) {
					const concurrent = await ctx.oidcPolicies.findByOrgSlugAndIssuer(
						ctx.caller.orgSlug,
						GITHUB_ACTIONS_ISSUER,
					);
					const concurrentOwned = concurrent.find(
						(policy) => policy.tenantId === ctx.caller.tenantId,
					);
					if (concurrentOwned) {
						return { policy: concurrentOwned, created: false as const };
					}
				}
				rethrowOidcPolicyError(error);
			}
		}),

	createPolicy: adminProcedure.input(createPolicyInput).mutation(async ({ ctx, input }) => {
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

	updatePolicy: adminProcedure.input(updatePolicyInput).mutation(async ({ ctx, input }) => {
		assertOidc(ctx);
		const { id, ...patch } = input;
		try {
			// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
			return await ctx.oidcPolicies!.update(id, ctx.caller.tenantId, patch);
		} catch (error) {
			rethrowOidcPolicyError(error);
		}
	}),

	deletePolicy: adminProcedure
		.input(
			z.object({
				id: z.string().refine((value) => UUID_V4_PATTERN.test(value), {
					message: "Invalid UUID",
				}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertOidc(ctx);
			// biome-ignore lint/style/noNonNullAssertion: assertOidc guards above
			await ctx.oidcPolicies!.delete(input.id, ctx.caller.tenantId);
			return { success: true };
		}),
});
