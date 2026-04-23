// @procella/api — ESC tRPC procedures (read-only queries for the dashboard).
// Mutations go through REST /api/esc/* for `esc` CLI compatibility.

import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

const projectInput = z.object({
	project: z.string().min(1),
});

const environmentInput = projectInput.extend({
	environment: z.string().min(1),
});

const revisionInput = environmentInput.extend({
	revision: z.number().int().min(1),
});

export const escRouter = router({
	listProjects: publicProcedure.query(async ({ ctx }) => {
		return ctx.esc.listProjects(ctx.caller.tenantId);
	}),

	listEnvironments: publicProcedure.input(projectInput).query(async ({ ctx, input }) => {
		return ctx.esc.listEnvironments(ctx.caller.tenantId, input.project);
	}),

	getEnvironment: publicProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		const env = await ctx.esc.getEnvironment(ctx.caller.tenantId, input.project, input.environment);
		if (!env) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Environment ${input.project}/${input.environment} not found`,
			});
		}
		return env;
	}),

	listRevisions: publicProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		return ctx.esc.listRevisions(ctx.caller.tenantId, input.project, input.environment);
	}),

	getRevision: publicProcedure.input(revisionInput).query(async ({ ctx, input }) => {
		const rev = await ctx.esc.getRevision(
			ctx.caller.tenantId,
			input.project,
			input.environment,
			input.revision,
		);
		if (!rev) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Revision ${input.project}/${input.environment}#${input.revision} not found`,
			});
		}
		return rev;
	}),
});
