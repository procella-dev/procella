/**
 * Parsed stack name reference. Canonical form is `org/project/stack` (Procella/Pulumi Cloud),
 * but DIY backends (local, S3, etc.) may return 2-part (`project/stack`) or 1-part (`stack`)
 * names — in those cases, `org` and/or `project` will be empty strings. Migration fills in
 * defaults (`imported` org, project = stack name) before calling Procella.
 */
export interface StackRef {
	/** Organization slug. Empty string for DIY backends that lack an org concept. */
	org: string;
	/** Project name. Empty string for 1-part DIY stack names. */
	project: string;
	/** Stack name. Always present. */
	stack: string;
}

/** Stack metadata returned by discovery */
export interface DiscoveredStack {
	fqn: string;
	ref: StackRef;
	resourceCount: number | null;
	lastUpdate: string | null;
}

/** Pulumi UntypedDeployment — the state checkpoint format */
export interface UntypedDeployment {
	version: number;
	deployment: {
		manifest?: {
			time: string;
			magic: string;
			version: string;
		};
		secrets_providers?: {
			type: string;
			state?: unknown;
		};
		resources?: Array<{
			urn: string;
			type: string;
			id?: string;
			inputs?: Record<string, unknown>;
			outputs?: Record<string, unknown>;
			[key: string]: unknown;
		}>;
		pending_operations?: unknown[];
		[key: string]: unknown;
	};
}

/** Per-stack migration result */
export interface MigrationResult {
	fqn: string;
	status: "succeeded" | "failed" | "skipped";
	sourceResourceCount: number;
	targetResourceCount: number | null;
	duration: number;
	error?: string;
	exportFile?: string;
}

/** Complete audit log for a migration run */
export interface AuditLog {
	runId: string;
	source: string;
	target: string;
	startedAt: string;
	completedAt: string | null;
	stacks: MigrationResult[];
	summary: {
		total: number;
		succeeded: number;
		failed: number;
		skipped: number;
	};
}

/** Shared options passed to all commands */
export interface GlobalOptions {
	sourceUrl: string;
	sourceToken: string;
	targetUrl: string;
	targetToken: string;
}

/** Options for the run command */
export interface RunOptions extends GlobalOptions {
	filter: string;
	exclude: string;
	dryRun: boolean;
	concurrency: number;
	continueOnError: boolean;
	keepExports: boolean;
	outputDir: string;
}

/** Options for the discover command */
export interface DiscoverOptions {
	sourceUrl: string;
	sourceToken: string;
	filter: string;
	exclude: string;
	format: "table" | "json";
}

/** Options for the validate command */
export interface ValidateOptions extends GlobalOptions {
	filter: string;
	exclude: string;
}

/** Options for the preflight command */
export interface PreflightOptions extends GlobalOptions {}

/** Validation comparison for a single stack */
export interface ValidationResult {
	fqn: string;
	status: "match" | "mismatch" | "missing-source" | "missing-target" | "error";
	sourceResourceCount: number;
	targetResourceCount: number;
	missingOnTarget: string[];
	missingOnSource: string[];
	error?: string;
}
