import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destinationRef, findDestinationCollisions } from "./destination.js";
import { migrateOne, type RunOperations, run } from "./migrate.js";
import { filterStacks } from "./procella.js";
import type { DiscoveredStack, RunOptions, UntypedDeployment } from "./types.js";

function makeStack(fqn: string): DiscoveredStack {
	const [org = "", project = "", stack = ""] = fqn.split("/");
	return { fqn, ref: { org, project, stack }, resourceCount: 1, lastUpdate: null };
}

function makeOptions(outputDir: string, filter = "*", exclude = ""): RunOptions {
	return {
		sourceUrl: "file://source",
		sourceToken: "source-token",
		targetUrl: "https://target.example.com",
		targetToken: "target-token",
		filter,
		exclude,
		dryRun: false,
		concurrency: 1,
		continueOnError: false,
		keepExports: false,
		outputDir,
	};
}

function successfulOperations(
	stacks: DiscoveredStack[],
	onMigrate: (stack: DiscoveredStack) => void,
): RunOperations {
	return {
		discoverStacks: async () => stacks,
		healthCheck: async () => true,
		migrateOne: async (stack) => {
			onMigrate(stack);
			return {
				fqn: stack.fqn,
				status: "succeeded",
				sourceResourceCount: 1,
				targetResourceCount: 1,
				duration: 0,
			};
		},
	};
}

describe("migration destination identity", () => {
	test("records cross-org collisions before target-side migration", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "procella-migration-collision-"));
		const stacks = [makeStack("org-a/project/stack"), makeStack("org-b/project/stack")];
		let healthChecks = 0;
		let targetWrites = 0;

		try {
			const audit = await run(makeOptions(outputDir), {
				discoverStacks: async () => stacks,
				healthCheck: async () => {
					healthChecks++;
					return true;
				},
				migrateOne: async () => {
					targetWrites++;
					throw new Error("must not migrate");
				},
			});

			expect(audit.summary).toEqual({ total: 2, succeeded: 0, failed: 2, skipped: 0 });
			expect(audit.stacks.map((result) => result.error)).toEqual([
				"Ambiguous target project/stack: conflicting sources org-a/project/stack, org-b/project/stack",
				"Ambiguous target project/stack: conflicting sources org-a/project/stack, org-b/project/stack",
			]);
			expect(healthChecks).toBe(0);
			expect(targetWrites).toBe(0);
		} finally {
			await rm(outputDir, { recursive: true, force: true });
		}
	});

	test("allows distinct effective target identities", () => {
		expect(
			findDestinationCollisions([makeStack("org-a/project/dev"), makeStack("org-b/project/prod")]),
		).toEqual([]);
	});

	test("continues with unaffected stacks when requested", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "procella-migration-continue-"));
		const migrated: string[] = [];
		const stacks = [
			makeStack("org-a/project/stack"),
			makeStack("org-b/project/stack"),
			makeStack("org-c/project/other"),
		];

		try {
			const audit = await run(
				{ ...makeOptions(outputDir), continueOnError: true },
				successfulOperations(stacks, (stack) => migrated.push(stack.fqn)),
			);
			expect(migrated).toEqual(["org-c/project/other"]);
			expect(audit.summary).toEqual({ total: 3, succeeded: 1, failed: 2, skipped: 0 });
		} finally {
			await rm(outputDir, { recursive: true, force: true });
		}
	});

	test("applies include and exclude filters before checking collisions", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "procella-migration-collision-"));
		const migrated: string[] = [];
		const stacks = [makeStack("org-a/project/stack"), makeStack("org-b/project/stack")];

		try {
			const audit = await run(
				makeOptions(outputDir, "org-*/**", "org-b/**"),
				successfulOperations(stacks, (stack) => migrated.push(stack.fqn)),
			);
			expect(migrated).toEqual(["org-a/project/stack"]);
			expect(audit.summary.succeeded).toBe(1);
		} finally {
			await rm(outputDir, { recursive: true, force: true });
		}
	});

	test("allows rerunning a source into an existing destination stack", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "procella-migration-rerun-"));
		const source = makeStack("org-a/project/stack");
		const deployment: UntypedDeployment = {
			version: 3,
			deployment: {
				resources: [{ urn: "urn:pulumi:dev::project::pkg:type::resource", type: "pkg:type" }],
			},
		};
		let imports = 0;

		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await migrateOne(source, 1, 1, makeOptions(outputDir), {
					exportStack: async (_fqn, filePath) => {
						await writeFile(filePath, JSON.stringify(deployment));
					},
					createStack: async () => ({ created: false }),
					importStack: async () => {
						imports++;
					},
					exportState: async () => deployment,
					batchDecrypt: async () => new Map(),
					getCallerOrg: async () => "org-a",
				});
				expect(result.status).toBe("succeeded");
			}
			expect(imports).toBe(2);
		} finally {
			await rm(outputDir, { recursive: true, force: true });
		}
	});

	test("uses existing DIY source-name fallbacks", () => {
		const diy = { org: "", project: "", stack: "dev" };
		expect(destinationRef(diy)).toEqual({ org: "imported", project: "dev", stack: "dev" });
		expect(
			findDestinationCollisions([
				{ ...makeStack("source/dev/dev"), fqn: "source/dev/dev" },
				{ ...makeStack("dev"), ref: diy },
			]),
		).toEqual([
			{
				key: JSON.stringify(["dev", "dev"]),
				identity: "dev/dev",
				sourceFqns: ["source/dev/dev", "dev"],
			},
		]);
	});

	test("does not treat duplicate discovery rows for one source as a collision", () => {
		const source = makeStack("org-a/project/stack");
		expect(findDestinationCollisions([source, source])).toEqual([]);
		expect(filterStacks([source], "org-a/**")).toEqual([source]);
	});
});
