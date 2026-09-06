// @procella/api — finding C1 regression: mutating stack procedures enforce caller roles.

import { describe, expect, mock, test } from "bun:test";
import type { StackInfo, StacksService } from "@procella/stacks";
import type { Caller, Role } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { TRPCContext } from "../trpc.js";
import { stacksRouter } from "./stacks.js";

interface ServiceMock {
	mock: { calls: unknown[][] };
}

interface RbacFixture {
	ctx: TRPCContext;
	serviceMocks: ServiceMock[];
}

interface MutationCase {
	name: string;
	requiredRole: "member" | "admin";
	run: (ctx: TRPCContext) => Promise<unknown>;
}

const stackInfo: StackInfo = {
	id: "stack-1",
	projectId: "project-1",
	tenantId: "tenant-1",
	orgName: "org",
	projectName: "project",
	stackName: "stack",
	tags: {},
	activeUpdateId: null,
	lastUpdate: null,
	resourceCount: null,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function fixtureFor(role: Role): RbacFixture {
	const caller: Caller = {
		tenantId: "tenant-1",
		orgSlug: "org",
		userId: "user-1",
		login: `${role}-user`,
		roles: [role],
		principalType: "user",
	};
	const replaceStackTags = mock(async () => {});
	const renameStack = mock(async () => {});
	const deleteStack = mock(async () => {});
	const getStack = mock(async () => stackInfo);
	const exportStack = mock(async () => ({ version: 3, deployment: { resources: [] } }));
	const importStack = mock(async () => ({ updateID: "update-1" }));
	const repairStack = mock(async () => []);

	return {
		ctx: {
			caller,
			resolveUserDisplayName: async () => null,
			db: {} as never,
			dbUrl: "",
			stacks: {
				replaceStackTags,
				renameStack,
				deleteStack,
				getStack,
			} as unknown as StacksService,
			audit: {} as never,
			updates: { exportStack, importStack, repairStack } as unknown as UpdatesService,
			webhooks: {} as never,
			esc: {} as never,
			github: null,
		},
		serviceMocks: [
			replaceStackTags,
			renameStack,
			deleteStack,
			getStack,
			exportStack,
			importStack,
			repairStack,
		],
	};
}

const mutationCases: MutationCase[] = [
	{
		name: "updateTags",
		requiredRole: "member",
		run: (ctx) =>
			stacksRouter
				.createCaller(ctx)
				.updateTags({ org: "org", project: "project", stack: "stack", tags: {} }),
	},
	{
		name: "rename",
		requiredRole: "member",
		run: (ctx) =>
			stacksRouter
				.createCaller(ctx)
				.rename({ org: "org", project: "project", stack: "stack", newStack: "renamed" }),
	},
	{
		name: "delete",
		requiredRole: "admin",
		run: (ctx) =>
			stacksRouter.createCaller(ctx).delete({ org: "org", project: "project", stack: "stack" }),
	},
	{
		name: "import",
		requiredRole: "member",
		run: (ctx) =>
			stacksRouter.createCaller(ctx).import({
				org: "org",
				project: "project",
				stack: "stack",
				deployment: { version: 3, deployment: {} },
			}),
	},
	{
		requiredRole: "member",
		name: "repair",
		run: (ctx) =>
			stacksRouter.createCaller(ctx).repair({ org: "org", project: "project", stack: "stack" }),
	},
];

describe("stacksRouter mutation RBAC", () => {
	for (const mutation of mutationCases) {
		for (const role of ["viewer", "member", "admin"] as const) {
			test(`${mutation.name} as ${role}`, async () => {
				const { ctx, serviceMocks } = fixtureFor(role);
				const result = mutation.run(ctx);

				const allowed =
					role === "admin" || (role === "member" && mutation.requiredRole === "member");
				if (!allowed) {
					await expect(result).rejects.toMatchObject({ code: "FORBIDDEN" });
					expect(serviceMocks.reduce((total, item) => total + item.mock.calls.length, 0)).toBe(0);
					return;
				}
				await result;
				expect(
					serviceMocks.reduce((total, item) => total + item.mock.calls.length, 0),
				).toBeGreaterThan(0);
			});
		}
	}
});

describe("stacksRouter read procedures stay available to viewers", () => {
	test("export resolves for a viewer caller", async () => {
		const { ctx } = fixtureFor("viewer");

		await expect(
			stacksRouter.createCaller(ctx).export({ org: "org", project: "project", stack: "stack" }),
		).resolves.toMatchObject({ version: 3 });
	});
});
