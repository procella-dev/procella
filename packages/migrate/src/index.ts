/**
 * @procella/migrate — Programmatic API for migrating Pulumi stacks to Procella.
 *
 * For CLI usage, run: bunx @procella/migrate --help
 */

export type {
	BatchSecretDecrypter,
	CompareDeploymentsOptions,
	DeploymentComparisonResult,
	DeploymentMismatch,
	DeploymentMismatchKind,
} from "./compare.js";
export { compareDeploymentState, describeFirstMismatch } from "./compare.js";
export { discover } from "./discover.js";
export { run } from "./migrate.js";
export { preflight } from "./preflight.js";
export type {
	AuditLog,
	DiscoveredStack,
	DiscoverOptions,
	GlobalOptions,
	MigrationResult,
	PreflightOptions,
	RunOptions,
	StackRef,
	UntypedDeployment,
	ValidateOptions,
	ValidationResult,
} from "./types.js";
export { validate } from "./validate.js";
