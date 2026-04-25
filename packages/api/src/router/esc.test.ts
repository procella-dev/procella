import { describe, expect, mock, test } from "bun:test";
import type { TRPCContext } from "../trpc.js";
import { escRouter } from "./esc.js";

const VALID_DRAFT_ID = "11111111-1111-1111-8111-111111111111";

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		db: {} as never,
		dbUrl: "",
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {
			listProjects: mock(async () => [
				{ id: "p1", tenantId: "t-1", name: "acme", createdAt: new Date(), updatedAt: new Date() },
			]),
			listEnvironments: mock(async () => [
				{
					id: "e1",
					projectId: "p1",
					name: "dev",
					yamlBody: "values:{}",
					currentRevisionNumber: 1,
					createdBy: "dev-user",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]),
			getEnvironment: mock(async () => ({
				id: "e1",
				projectId: "p1",
				name: "dev",
				yamlBody: "values:{}",
				currentRevisionNumber: 1,
				createdBy: "dev-user",
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
			listRevisions: mock(async () => [
				{
					id: "r1",
					environmentId: "e1",
					revisionNumber: 1,
					yamlBody: "values:{}",
					createdBy: "dev-user",
					createdAt: new Date(),
				},
			]),
			getRevision: mock(async () => ({
				id: "r1",
				environmentId: "e1",
				revisionNumber: 1,
				yamlBody: "values:{}",
				createdBy: "dev-user",
				createdAt: new Date(),
			})),
			listRevisionTags: mock(async () => [
				{ name: "stable", revisionNumber: 1, createdBy: "dev-user", createdAt: new Date() },
			]),
			getEnvironmentTags: mock(async () => ({ team: "platform" })),
			listDrafts: mock(async () => [
				{
					id: "d1",
					environmentId: "e1",
					yamlBody: "values:{}",
					description: "draft",
					createdBy: "dev-user",
					status: "open",
					appliedRevisionId: null,
					appliedAt: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]),
			getDraft: mock(async () => ({
				id: "d1",
				environmentId: "e1",
				yamlBody: "values:{}",
				description: "draft",
				createdBy: "dev-user",
				status: "open",
				appliedRevisionId: null,
				appliedAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
		} as never,
		github: null,
		...overrides,
	};
}

describe("escRouter", () => {
	test("lists projects and environments for the caller tenant", async () => {
		const ctx = mockContext();
		const caller = escRouter.createCaller(ctx);

		await expect(caller.listProjects()).resolves.toHaveLength(1);
		await expect(caller.listEnvironments({ project: "acme" })).resolves.toHaveLength(1);
		expect(ctx.esc.listProjects).toHaveBeenCalledWith("t-1");
		expect(ctx.esc.listEnvironments).toHaveBeenCalledWith("t-1", "acme");
	});

	test("returns environment, revisions, tags, and drafts for the requested environment", async () => {
		const ctx = mockContext();
		const caller = escRouter.createCaller(ctx);

		await expect(
			caller.getEnvironment({ project: "acme", environment: "dev" }),
		).resolves.toMatchObject({ name: "dev" });
		await expect(
			caller.listRevisions({ project: "acme", environment: "dev" }),
		).resolves.toHaveLength(1);
		await expect(
			caller.getRevision({ project: "acme", environment: "dev", revision: 1 }),
		).resolves.toMatchObject({ revisionNumber: 1 });
		await expect(
			caller.listRevisionTags({ project: "acme", environment: "dev" }),
		).resolves.toHaveLength(1);
		await expect(
			caller.getEnvironmentTags({ project: "acme", environment: "dev" }),
		).resolves.toEqual({ team: "platform" });
		await expect(
			caller.listDrafts({ project: "acme", environment: "dev", status: "open" }),
		).resolves.toHaveLength(1);
		await expect(
			caller.getDraft({ project: "acme", environment: "dev", draftId: VALID_DRAFT_ID }),
		).resolves.toMatchObject({ id: "d1" });
	});

	test("maps missing environment, revision, and draft to NOT_FOUND errors", async () => {
		const ctx = mockContext({
			esc: {
				...mockContext().esc,
				getEnvironment: mock(async () => null),
				getRevision: mock(async () => null),
				getDraft: mock(async () => null),
			} as never,
		});
		const caller = escRouter.createCaller(ctx);

		await expect(
			caller.getEnvironment({ project: "acme", environment: "missing" }),
		).rejects.toThrow("Environment acme/missing not found");
		await expect(
			caller.getRevision({ project: "acme", environment: "dev", revision: 2 }),
		).rejects.toThrow("Revision acme/dev#2 not found");
		await expect(
			caller.getDraft({ project: "acme", environment: "dev", draftId: VALID_DRAFT_ID }),
		).rejects.toThrow(`Draft ${VALID_DRAFT_ID} not found`);
	});

	test("validates required inputs and draft status values", async () => {
		const ctx = mockContext();
		const caller = escRouter.createCaller(ctx);

		await expect(caller.listEnvironments({ project: "" })).rejects.toThrow();
		await expect(
			caller.getRevision({ project: "acme", environment: "dev", revision: 0 }),
		).rejects.toThrow();
		await expect(
			caller.getDraft({ project: "acme", environment: "dev", draftId: "not-a-uuid" }),
		).rejects.toThrow();
		await expect(
			caller.listDrafts({ project: "acme", environment: "dev", status: "bad" as never }),
		).rejects.toThrow();
	});
});
