import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiscoveredStack, UntypedDeployment } from "./types.js";

const mockDiscoverStacks = mock(async (_url: string, _token: string): Promise<DiscoveredStack[]> => []);
const mockExportState = mock(
	async (_opts: { url: string; token: string }, _org: string, _project: string, _stack: string) =>
		({ version: 3, deployment: { resources: [] } }) as UntypedDeployment,
);
const mockFilterStacks = mock(
	(stacks: DiscoveredStack[], _pattern: string, _exclude?: string) => stacks,
);

mock.module("./procella.js", () => ({
	discoverStacks: mockDiscoverStacks,
	exportState: mockExportState,
	filterStacks: mockFilterStacks,
}));

mock.module("./log.js", () => ({
	heading: mock(() => {}),
	info: mock(() => {}),
	warn: mock(() => {}),
	table: mock(() => {}),
}));

const { validate } = await import("./validate.js");

function makeStack(fqn: string, resourceCount: number): DiscoveredStack {
	const [org = "", project = "", stack = ""] = fqn.split("/");
	return {
		fqn,
		ref: { org, project, stack },
		resourceCount,
		lastUpdate: null,
	};
}

function makeDeployment(...urns: string[]): UntypedDeployment {
	return {
		version: 3,
		deployment: {
			resources: urns.map((urn) => ({ urn, type: "test:index:Resource" })),
		},
	};
}

describe("validate", () => {
	beforeEach(() => {
		mockDiscoverStacks.mockReset();
		mockExportState.mockReset();
		mockFilterStacks.mockReset();
		mockFilterStacks.mockImplementation((stacks) => stacks);
	});

	test("matches source and target stacks by project/stack when org slugs differ", async () => {
		const source = makeStack("legacy/payments/dev", 1);
		const target = makeStack("tenant-a/payments/dev", 1);
		const deployment = makeDeployment("urn:pulumi:dev::payments::pkg:index:Thing::main");

		mockDiscoverStacks.mockImplementation(async (url) =>
			url === "https://source.example" ? [source] : [target],
		);
		mockExportState.mockImplementation(async (_opts, org, project, stack) => {
			expect(`${project}/${stack}`).toBe("payments/dev");
			return deployment;
		});

		const results = await validate({
			sourceUrl: "https://source.example",
			sourceToken: "source-token",
			targetUrl: "https://target.example",
			targetToken: "target-token",
			filter: "*",
			exclude: "",
		});

		expect(results).toEqual([
			{
				fqn: "legacy/payments/dev",
				status: "match",
				sourceResourceCount: 1,
				targetResourceCount: 1,
				missingOnTarget: [],
				missingOnSource: [],
			},
		]);
		expect(mockExportState).toHaveBeenCalledWith(
			{ url: "https://target.example", token: "target-token" },
			"tenant-a",
			"payments",
			"dev",
		);
	});

	test("does not report target stacks as missing-source when only the org differs", async () => {
		const source = makeStack("legacy/payments/dev", 1);
		const target = makeStack("tenant-a/payments/dev", 1);

		mockDiscoverStacks.mockImplementation(async (url) =>
			url === "https://source.example" ? [source] : [target],
		);
		mockExportState.mockResolvedValue(makeDeployment("urn:pulumi:dev::payments::pkg:index:Thing::main"));

		const results = await validate({
			sourceUrl: "https://source.example",
			sourceToken: "source-token",
			targetUrl: "https://target.example",
			targetToken: "target-token",
			filter: "*",
			exclude: "",
		});

		expect(results.some((result) => result.status === "missing-source")).toBe(false);
		expect(results).toHaveLength(1);
	});
});
