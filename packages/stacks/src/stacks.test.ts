import { describe, expect, test } from "bun:test";
import { parseStackFQN } from "@procella/types";
import type { StackInfo, StacksService } from "./index.js";
import { buildStackTags, mergeTags } from "./index.js";

describe("@procella/stacks", () => {
	// ========================================================================
	// StackInfo type structure (compile-time check)
	// ========================================================================

	describe("StackInfo type", () => {
		test("satisfies expected shape", () => {
			const info: StackInfo = {
				id: "uuid-1",
				projectId: "uuid-2",
				tenantId: "tenant-a",
				orgName: "tenant-a",
				projectName: "my-proj",
				stackName: "dev",
				tags: { "pulumi:project": "my-proj", "pulumi:stack": "dev" },
				activeUpdateId: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			expect(info.id).toBe("uuid-1");
			expect(info.projectId).toBe("uuid-2");
			expect(info.tenantId).toBe("tenant-a");
			expect(info.orgName).toBe("tenant-a");
			expect(info.projectName).toBe("my-proj");
			expect(info.stackName).toBe("dev");
			expect(info.activeUpdateId).toBeNull();
			expect(info.tags).toEqual({
				"pulumi:project": "my-proj",
				"pulumi:stack": "dev",
			});
		});
	});

	// ========================================================================
	// buildStackTags — Pulumi standard tags
	// ========================================================================

	describe("buildStackTags", () => {
		test("sets pulumi:project and pulumi:stack", () => {
			const tags = buildStackTags("my-proj", "production");
			expect(tags).toEqual({
				"pulumi:project": "my-proj",
				"pulumi:stack": "production",
			});
		});

		test("merges user tags after standard tags", () => {
			const tags = buildStackTags("proj", "stk", {
				env: "prod",
				team: "infra",
			});
			expect(tags).toEqual({
				"pulumi:project": "proj",
				"pulumi:stack": "stk",
				env: "prod",
				team: "infra",
			});
		});

		test("user tags can override standard tags", () => {
			const tags = buildStackTags("proj", "stk", {
				"pulumi:project": "custom-name",
			});
			expect(tags["pulumi:project"]).toBe("custom-name");
		});
	});

	// ========================================================================
	// mergeTags
	// ========================================================================

	describe("mergeTags", () => {
		test("preserves existing tags and adds new ones", () => {
			const existing = { a: "1", b: "2" };
			const incoming = { c: "3", d: "4" };
			const result = mergeTags(existing, incoming);
			expect(result).toEqual({ a: "1", b: "2", c: "3", d: "4" });
		});

		test("incoming tags override existing tags", () => {
			const existing = { a: "1", b: "2" };
			const incoming = { b: "override", c: "3" };
			const result = mergeTags(existing, incoming);
			expect(result).toEqual({ a: "1", b: "override", c: "3" });
		});

		test("does not mutate inputs", () => {
			const existing = { a: "1" };
			const incoming = { b: "2" };
			mergeTags(existing, incoming);
			expect(existing).toEqual({ a: "1" });
			expect(incoming).toEqual({ b: "2" });
		});
	});

	// ========================================================================
	// FQN parsing (via @procella/types, tested for stacks context)
	// ========================================================================

	describe("FQN parsing", () => {
		test("parses valid org/project/stack FQN", () => {
			const fqn = parseStackFQN("acme/webapp/production");
			expect(fqn).toEqual({
				org: "acme",
				project: "webapp",
				stack: "production",
			});
		});

		test("throws on too few parts", () => {
			expect(() => parseStackFQN("acme/webapp")).toThrow("Invalid stack FQN");
		});

		test("throws on too many parts", () => {
			expect(() => parseStackFQN("a/b/c/d")).toThrow("Invalid stack FQN");
		});

		test("throws on empty string", () => {
			expect(() => parseStackFQN("")).toThrow("Invalid stack FQN");
		});
	});

	// ========================================================================
	// StacksService interface type check
	// ========================================================================

	describe("StacksService interface", () => {
		test("can define a mock satisfying the interface", () => {
			const mockInfo: StackInfo = {
				id: "id",
				projectId: "pid",
				tenantId: "tid",
				orgName: "tid",
				projectName: "p",
				stackName: "s",
				tags: {},
				activeUpdateId: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			const mock: StacksService = {
				createStack: async () => mockInfo,
				getStack: async () => mockInfo,
				listStacks: async () => [mockInfo],
				deleteStack: async () => {},
				renameStack: async () => {},
				updateStackTags: async () => {},
				getStackByFQN: async () => mockInfo,
			};

			// Type-level check: all methods exist and are callable
			expect(typeof mock.createStack).toBe("function");
			expect(typeof mock.getStack).toBe("function");
			expect(typeof mock.listStacks).toBe("function");
			expect(typeof mock.deleteStack).toBe("function");
			expect(typeof mock.renameStack).toBe("function");
			expect(typeof mock.updateStackTags).toBe("function");
			expect(typeof mock.getStackByFQN).toBe("function");
		});

		test("listStacks accepts optional org/project filters", async () => {
			const mock: StacksService = {
				createStack: async () => ({}) as StackInfo,
				getStack: async () => ({}) as StackInfo,
				listStacks: async (_tid, _org?, _proj?) => [],
				deleteStack: async () => {},
				renameStack: async () => {},
				updateStackTags: async () => {},
				getStackByFQN: async () => ({}) as StackInfo,
			};

			// No filters
			const noFilter = await mock.listStacks("tid");
			expect(noFilter).toEqual([]);

			// With org filter
			const withOrg = await mock.listStacks("tid", "org");
			expect(withOrg).toEqual([]);

			// With org + project filter
			const withBoth = await mock.listStacks("tid", "org", "proj");
			expect(withBoth).toEqual([]);
		});
	});
});
