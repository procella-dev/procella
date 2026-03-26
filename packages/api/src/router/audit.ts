import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { publicProcedure, router } from "../trpc.js";

const auditListInput = z.object({
	startTime: z.date().optional(),
	endTime: z.date().optional(),
	action: z.string().optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(200).default(50),
});

const auditExportInput = z.object({
	startTime: z.date().optional(),
	endTime: z.date().optional(),
	action: z.string().optional(),
});

function assertAdmin(roles: readonly string[]): void {
	if (!roles.includes("admin")) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
	}
}

export const auditRouter = router({
	list: publicProcedure.input(auditListInput).query(async ({ ctx, input }) => {
		assertAdmin(ctx.caller.roles);
		return ctx.audit.query(ctx.caller.tenantId, {
			startTime: input.startTime,
			endTime: input.endTime,
			action: input.action,
			page: input.page,
			pageSize: input.pageSize,
		});
	}),

	export: publicProcedure.input(auditExportInput).query(async ({ ctx, input }) => {
		assertAdmin(ctx.caller.roles);
		return ctx.audit.export(ctx.caller.tenantId, {
			startTime: input.startTime,
			endTime: input.endTime,
			action: input.action,
		});
	}),
});
