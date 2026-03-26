import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

const orgInput = z.object({ org: z.string() });

function assertAdmin(roles: readonly string[]): void {
	if (!roles.includes("admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
	}
}

export const githubRouter = router({
	installation: publicProcedure.input(orgInput).query(async ({ ctx, input }) => {
		if (input.org !== ctx.caller.orgSlug) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Organization does not match caller organization",
			});
		}

		if (!ctx.github) {
			return null;
		}

		return ctx.github.getInstallation(ctx.caller.tenantId);
	}),

	removeInstallation: publicProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
		if (input.org !== ctx.caller.orgSlug) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Organization does not match caller organization",
			});
		}
		assertAdmin(ctx.caller.roles);

		if (!ctx.github) {
			return { success: true };
		}

		const installation = await ctx.github.getInstallation(ctx.caller.tenantId);
		if (installation) {
			await ctx.github.removeInstallation(installation.installationId);
		}

		return { success: true };
	}),
});
