import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { stacksRouter } from "./stacks.js";

function mockContext(deleteStack: TRPCContext["stacks"]["deleteStack"]): TRPCContext {
	return {
		caller: {
			tenantId: "tenant-1",
			orgSlug: "org-1",
			userId: "user-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: async () => null,
		db: {} as never,
		notifications: {} as never,
		stacks: { deleteStack } as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
	};
}

describe("stacks.delete", () => {
	test("forwards force to the stack service", async () => {
		const deleteStack = mock(async () => {});
		const caller = stacksRouter.createCaller(mockContext(deleteStack));

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev", force: true });

		expect(deleteStack).toHaveBeenCalledWith("tenant-1", "org-1", "project-1", "dev", true);
	});

	test("keeps deletion guarded when force is omitted", async () => {
		const deleteStack = mock(async () => {});
		const caller = stacksRouter.createCaller(mockContext(deleteStack));

		await caller.delete({ org: "org-1", project: "project-1", stack: "dev" });

		expect(deleteStack).toHaveBeenCalledWith("tenant-1", "org-1", "project-1", "dev", undefined);
	});
});
