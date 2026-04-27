import { adminProcedure, protectedProcedure, router } from "../trpc.js";

export const githubRouter = router({
	installation: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.github) {
			return null;
		}
		return ctx.github.getInstallation(ctx.caller.tenantId);
	}),

	removeInstallation: adminProcedure.mutation(async ({ ctx }) => {
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
