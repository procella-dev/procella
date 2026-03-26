import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc.js";

function assertAdmin(roles: readonly string[]): void {
	if (!roles.includes("admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
	}
}

export const githubRouter = router({
	installation: publicProcedure.query(async ({ ctx }) => {
		if (!ctx.github) {
			return null;
		}
		return ctx.github.getInstallation(ctx.caller.tenantId);
	}),

	removeInstallation: publicProcedure.mutation(async ({ ctx }) => {
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
