import { describe, expect, test } from "bun:test";

const WORKFLOW_PATH = new URL("../.github/workflows/renovate.yml", import.meta.url).pathname;
const RENOVATE_VERSION = "44.65.5";

interface WorkflowStep {
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
	run?: string;
}

interface WorkflowJob {
	if?: string;
	permissions?: Record<string, string>;
	steps: WorkflowStep[];
}

interface RenovateWorkflow {
	on: {
		pull_request: {
			paths: string[];
		};
		[event: string]: unknown;
	};
	env: Record<string, string>;
	jobs: Record<string, WorkflowJob>;
}

const source = await Bun.file(WORKFLOW_PATH).text();
const workflow = Bun.YAML.parse(source) as RenovateWorkflow;

function requireJob(name: string): WorkflowJob {
	const job = workflow.jobs[name];
	if (!job) {
		throw new Error(`missing workflow job: ${name}`);
	}
	return job;
}

const validationJob = requireJob("validate-config");
const privilegedJob = requireJob("renovate");

describe("H13 Renovate workflow privilege boundary", () => {
	test("marker-only pull requests cannot enter the privileged job or receive its App token", () => {
		expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
		expect(Object.keys(workflow.jobs).sort()).toEqual(["renovate", "validate-config"]);
		expect(workflow.on.pull_request.paths).toContain(".github/renovate-global.js");
		expect(validationJob.if).toBe("github.event_name == 'pull_request'");
		expect(validationJob.permissions).toEqual({ contents: "read" });
		expect(privilegedJob.if).toBe(
			"github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
		);

		const validationDefinition = JSON.stringify(validationJob);
		expect(validationDefinition).not.toContain("secrets.");
		expect(validationDefinition).not.toContain("create-github-app-token");
		expect(validationDefinition).not.toContain("RENOVATE_TOKEN");
		expect(validationDefinition).not.toContain("get_token");
	});

	test("privileged runs load configuration from the repository default branch", () => {
		const checkout = privilegedJob.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
		expect(checkout).toBeDefined();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
		expect(checkout?.with?.ref).toBe("${{ github.event.repository.default_branch }}");
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
	});

	test("uses one exact Renovate version for validation and privileged execution", () => {
		const validation = validationJob.steps.find((step) => step.name === "Validate Renovate config");
		const renovate = privilegedJob.steps.find((step) => step.name === "Run Renovate");

		expect(workflow.env.RENOVATE_VERSION).toBe(RENOVATE_VERSION);
		expect(validation?.run).toBe(
			'bunx --package "renovate@$RENOVATE_VERSION" renovate-config-validator .github/renovate-global.js',
		);
		expect(renovate?.run).toBe('bunx "renovate@$RENOVATE_VERSION"');
	});
});
