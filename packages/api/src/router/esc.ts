// @procella/api — ESC tRPC procedures (read-only queries for the dashboard).
// Mutations go through REST /api/esc/* for `esc` CLI compatibility.

import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../trpc.js";

const projectInput = z.object({
	project: z.string().min(1),
});

const environmentInput = projectInput.extend({
	environment: z.string().min(1),
});

const revisionInput = environmentInput.extend({
	revision: z.number().int().min(1),
});

const draftInput = environmentInput.extend({
	draftId: z.string().uuid(),
});

const draftStatusFilter = environmentInput.extend({
	status: z.enum(["open", "applied", "discarded"]).optional(),
});

export const escRouter = router({
	listProjects: protectedProcedure.query(async ({ ctx }) => {
		return ctx.esc.listProjects(ctx.caller.tenantId);
	}),

	listEnvironments: protectedProcedure.input(projectInput).query(async ({ ctx, input }) => {
		return ctx.esc.listEnvironments(ctx.caller.tenantId, input.project);
	}),

	getEnvironment: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		const env = await ctx.esc.getEnvironment(ctx.caller.tenantId, input.project, input.environment);
		if (!env) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Environment ${input.project}/${input.environment} not found`,
			});
		}
		return env;
	}),

	listRevisions: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		return ctx.esc.listRevisions(ctx.caller.tenantId, input.project, input.environment);
	}),

	getRevision: protectedProcedure.input(revisionInput).query(async ({ ctx, input }) => {
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

	listRevisionTags: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		return ctx.esc.listRevisionTags(ctx.caller.tenantId, input.project, input.environment);
	}),

	getEnvironmentTags: protectedProcedure.input(environmentInput).query(async ({ ctx, input }) => {
		return ctx.esc.getEnvironmentTags(ctx.caller.tenantId, input.project, input.environment);
	}),

	listDrafts: protectedProcedure.input(draftStatusFilter).query(async ({ ctx, input }) => {
		return ctx.esc.listDrafts(ctx.caller.tenantId, input.project, input.environment, input.status);
	}),

	getDraft: protectedProcedure.input(draftInput).query(async ({ ctx, input }) => {
		const draft = await ctx.esc.getDraft(
			ctx.caller.tenantId,
			input.project,
			input.environment,
			input.draftId,
		);
		if (!draft) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Draft ${input.draftId} not found`,
			});
		}
		return draft;
	}),
});
