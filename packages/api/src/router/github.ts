import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { adminProcedure, protectedProcedure, router } from "../trpc.js";

export const githubRouter = router({
	status: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.github) {
			return { configured: false as const, installations: [] };
		}
		return {
			configured: true as const,
			installations: await ctx.github.listInstallations(ctx.caller.tenantId),
		};
	}),

	createInstallationUrl: adminProcedure
		.input(
			z.object({
				accountLogin: z
					.string()
					.trim()
					.min(1)
					.max(100)
					.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.github) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "GitHub App is not configured on this server",
				});
			}
			return {
				url: await ctx.github.issueAuthorizationUrl(ctx.caller.tenantId, input.accountLogin),
			};
		}),

	removeInstallation: adminProcedure
		.input(z.object({ installationId: z.number().int().positive() }))
		.mutation(async ({ ctx, input }) => {
			await ctx.github?.removeInstallation(ctx.caller.tenantId, input.installationId);
			return { success: true };
		}),
});
