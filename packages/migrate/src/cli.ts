#!/usr/bin/env node
import { parseArgs } from "node:util";
import { discover } from "./discover.js";
import * as log from "./log.js";
import { run } from "./migrate.js";
import { preflight } from "./preflight.js";
import { validate } from "./validate.js";

const USAGE = `
procella-migrate — Migrate Pulumi stacks to Procella

Usage:
  procella-migrate <command> [options]

Commands:
  discover     List stacks on a source backend
  run          Migrate stacks from source to Procella
  validate     Compare stacks between source and target
  preflight    Run pre-migration connectivity and auth checks

Global Options:
  --source <url>          Source backend URL
  --source-token <token>  Source backend token (or PROCELLA_MIGRATE_SOURCE_TOKEN / PULUMI_ACCESS_TOKEN)
  --target <url>          Target Procella URL
  --target-token <token>  Target Procella token (or PROCELLA_MIGRATE_TARGET_TOKEN)
  --help                  Show this help message

Run Options:
  --filter <glob>         Stack name filter (default: "*")
  --exclude <glob>        Exclude stacks matching pattern
  --dry-run               Validate without modifying target
  --concurrency <n>       Parallel stack migrations (default: 1)
  --continue-on-error     Skip failed stacks and continue
  --keep-exports          Retain export files after migration
  --output-dir <path>     Directory for exports and audit (default: ./migration-exports)

Discover Options:
  --format <table|json>   Output format (default: table)

Examples:
  # Discover stacks on Pulumi Cloud
  procella-migrate discover --source https://api.pulumi.com

  # Dry-run migration
  procella-migrate run \\
    --source https://api.pulumi.com \\
    --target https://procella.example.com \\
    --dry-run

  # Migrate only dev stacks
  procella-migrate run \\
    --source https://api.pulumi.com \\
    --target https://procella.example.com \\
    --filter "*/*/dev"

  # Validate after migration
  procella-migrate validate \\
    --source https://api.pulumi.com \\
    --target https://procella.example.com
`;

function resolveToken(
	explicit: string | boolean | undefined,
	envKey: string,
	fallbackEnv: string,
): string {
	if (typeof explicit === "string" && explicit) return explicit;
	const fromEnv = process.env[envKey];
	if (fromEnv) return fromEnv;
	const fallback = process.env[fallbackEnv];
	if (fallback) return fallback;
	return "";
}

function parseConcurrency(value: string | boolean | undefined): number {
	const raw = String(value ?? "1");
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		log.error(`Invalid --concurrency value: ${raw}. Must be a positive integer.`);
		process.exit(1);
	}
	return n;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (!command || command === "--help" || command === "-h") {
		log.info(USAGE);
		process.exit(0);
	}

	const { values } = parseArgs({
		args: process.argv.slice(3),
		options: {
			source: { type: "string" },
			"source-token": { type: "string" },
			target: { type: "string" },
			"target-token": { type: "string" },
			filter: { type: "string", default: "*" },
			exclude: { type: "string", default: "" },
			"dry-run": { type: "boolean", default: false },
			concurrency: { type: "string", default: "1" },
			"continue-on-error": { type: "boolean", default: false },
			"keep-exports": { type: "boolean", default: false },
			"output-dir": { type: "string", default: "./migration-exports" },
			format: { type: "string", default: "table" },
			help: { type: "boolean", default: false },
		},
		strict: true,
	});

	if (values.help) {
		log.info(USAGE);
		process.exit(0);
	}

	const sourceUrl = String(values.source ?? "");
	const targetUrl = String(values.target ?? "");
	const sourceToken = resolveToken(
		values["source-token"],
		"PROCELLA_MIGRATE_SOURCE_TOKEN",
		"PULUMI_ACCESS_TOKEN",
	);
	const targetToken = resolveToken(values["target-token"], "PROCELLA_MIGRATE_TARGET_TOKEN", "");

	switch (command) {
		case "discover": {
			if (!sourceUrl) {
				log.error("--source is required for discover");
				process.exit(1);
			}
			// Source token only required for service backends (Pulumi Cloud, Procella)
			// Local/S3/GCS/Azure backends use ambient cloud credentials via Pulumi CLI
			await discover({
				sourceUrl,
				sourceToken,
				filter: String(values.filter ?? "*"),
				exclude: String(values.exclude ?? ""),
				format: values.format === "json" ? "json" : "table",
			});
			break;
		}

		case "run": {
			if (!sourceUrl || !targetUrl) {
				log.error("Both --source and --target are required for run");
				process.exit(1);
			}
			// Source token only required for service backends
			const isDryRun = Boolean(values["dry-run"]);
			if (!targetToken && !isDryRun) {
				log.error("Target token is required (--target-token or PROCELLA_MIGRATE_TARGET_TOKEN)");
				process.exit(1);
			}
			const audit = await run({
				sourceUrl,
				targetUrl,
				sourceToken,
				targetToken,
				filter: String(values.filter ?? "*"),
				exclude: String(values.exclude ?? ""),
				dryRun: Boolean(values["dry-run"]),
				concurrency: parseConcurrency(values.concurrency),
				continueOnError: Boolean(values["continue-on-error"]),
				keepExports: Boolean(values["keep-exports"]),
				outputDir: String(values["output-dir"] ?? "./migration-exports"),
			});
			process.exit(audit.summary.failed > 0 ? 1 : 0);
			break;
		}

		case "validate": {
			if (!sourceUrl || !targetUrl) {
				log.error("Both --source and --target are required for validate");
				process.exit(1);
			}
			if (!targetToken) {
				log.error("Target token is required (--target-token or PROCELLA_MIGRATE_TARGET_TOKEN)");
				process.exit(1);
			}
			const results = await validate({
				sourceUrl,
				targetUrl,
				sourceToken,
				targetToken,
				filter: String(values.filter ?? "*"),
				exclude: String(values.exclude ?? ""),
			});
			const hasIssues = results.some((r) => r.status !== "match");
			const isEmpty = results.length === 0;
			process.exit(hasIssues || isEmpty ? 1 : 0);
			break;
		}

		case "preflight": {
			if (!sourceUrl || !targetUrl) {
				log.error("Both --source and --target are required for preflight");
				process.exit(1);
			}
			const passed = await preflight({
				sourceUrl,
				targetUrl,
				sourceToken,
				targetToken,
			});
			process.exit(passed ? 0 : 1);
			break;
		}

		default:
			log.error(`Unknown command: ${command}`);
			log.info(USAGE);
			process.exit(1);
	}
}

main().catch((err) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
