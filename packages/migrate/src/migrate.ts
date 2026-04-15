import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createAuditLog, finalizeAuditLog, recordResult, writeAuditLog } from "./audit.js";
import * as log from "./log.js";
import * as procella from "./procella.js";
import { discoverStacks, filterStacks } from "./procella.js";
import * as pulumi from "./pulumi.js";
import type {
	AuditLog,
	DiscoveredStack,
	MigrationResult,
	RunOptions,
	UntypedDeployment,
} from "./types.js";

export async function run(opts: RunOptions): Promise<AuditLog> {
	const audit = createAuditLog(opts.sourceUrl, opts.targetUrl);

	log.heading("Procella Migration");
	log.dim(`Source: ${opts.sourceUrl}`);
	log.dim(`Target: ${opts.targetUrl}`);
	if (opts.dryRun) log.warn("Dry-run mode — no changes will be made to the target\n");

	// 1. Discover stacks
	log.step(1, 4, "Discovering stacks on source backend...");
	const sourceStacks = await discoverStacks(opts.sourceUrl, opts.sourceToken);
	const filtered = filterStacks(sourceStacks, opts.filter, opts.exclude || undefined);

	if (filtered.length === 0) {
		log.warn("No stacks match the filter. Nothing to migrate.");
		finalizeAuditLog(audit);
		return audit;
	}

	log.success(`Found ${filtered.length} stacks to migrate`);

	// Warn but don't abort — target may come online during a long migration,
	// and each stack import fails individually with a clear error in the audit log.
	const targetOk = await procella.healthCheck(opts.targetUrl);
	if (!targetOk) {
		log.warn(
			`Target ${opts.targetUrl} is not reachable. ${opts.dryRun ? "Real migration will fail." : "Migration may fail."}`,
		);
	}

	// 2. Create output directory for exports
	await mkdir(opts.outputDir, { recursive: true });

	// 3. Migrate stacks (sequential or concurrent)
	log.step(2, 4, "Migrating stacks...\n");

	if (opts.concurrency <= 1) {
		for (let i = 0; i < filtered.length; i++) {
			const result = await migrateStack(filtered[i], i + 1, filtered.length, opts);
			recordResult(audit, result);

			if (result.status === "failed" && !opts.continueOnError) {
				log.error("Migration stopped due to error. Use --continue-on-error to skip failures.");
				break;
			}
		}
	} else {
		// Concurrent migration with limited parallelism
		const queue = [...filtered];
		const inflight: Promise<void>[] = [];
		let index = 0;
		let aborted = false;

		const processNext = async (): Promise<void> => {
			while (queue.length > 0 && !aborted) {
				const stack = queue.shift();
				if (!stack) break;
				index++;
				const result = await migrateStack(stack, index, filtered.length, opts);
				recordResult(audit, result);

				if (result.status === "failed" && !opts.continueOnError) {
					aborted = true;
					queue.length = 0;
					break;
				}
			}
		};

		for (let i = 0; i < opts.concurrency; i++) {
			inflight.push(processNext());
		}
		await Promise.all(inflight);
	}

	// 4. Write audit log
	finalizeAuditLog(audit);
	log.step(3, 4, "Writing audit log...");
	const auditPath = await writeAuditLog(audit, opts.outputDir);
	log.success(`Audit log: ${auditPath}`);

	// 5. Summary
	log.step(4, 4, "Done\n");
	log.heading("Summary");
	log.info(`  Total:     ${audit.summary.total}`);
	log.success(`Succeeded: ${audit.summary.succeeded}`);
	if (audit.summary.failed > 0) log.error(`Failed:    ${audit.summary.failed}`);
	if (audit.summary.skipped > 0) log.warn(`Skipped:   ${audit.summary.skipped}`);

	if (!opts.dryRun && audit.summary.succeeded > 0) {
		log.info("\nNext steps:");
		log.info("  1. Run 'pulumi preview' on each migrated stack to verify zero changes");
		log.info("  2. Set 'backend.url' in each project's Pulumi.yaml to lock to Procella");
		log.info("  3. Commit the Pulumi.yaml change so your team picks it up automatically");
	}

	return audit;
}

async function migrateStack(
	stack: DiscoveredStack,
	index: number,
	total: number,
	opts: RunOptions,
): Promise<MigrationResult> {
	const start = Date.now();
	// Use directory hierarchy to avoid filename collisions.
	// Always create org/project dirs, defaulting the same way migration does.
	const org = stack.ref.org || "imported";
	const project = stack.ref.project || stack.ref.stack || "default";
	const stackName = stack.ref.stack || stack.fqn;
	const stackDir = join(opts.outputDir, org, project);
	await mkdir(stackDir, { recursive: true });
	const exportFile = join(stackDir, `${stackName}.json`);

	log.info(`  [${index}/${total}] ${stack.fqn}`);

	let sourceResourceCount = 0;
	try {
		// Phase 1: Export from source
		log.dim(`           Exporting from source...`);
		await pulumi.exportStack(stack.fqn, exportFile, {
			backendUrl: opts.sourceUrl,
			token: opts.sourceToken,
		});

		// Parse and validate the export
		const raw = await readFile(exportFile, "utf-8");
		const deployment: UntypedDeployment = JSON.parse(raw);
		sourceResourceCount = deployment.deployment.resources?.length ?? 0;

		log.dim(`           Exported ${sourceResourceCount} resources`);

		if (opts.dryRun) {
			// Clean up export file — contains plaintext secrets from --show-secrets
			if (!opts.keepExports) {
				await rm(exportFile, { force: true });
			}
			log.success(`         ${stack.fqn} — dry run OK (${sourceResourceCount} resources)`);
			return {
				fqn: stack.fqn,
				status: "succeeded",
				sourceResourceCount,
				targetResourceCount: null,
				duration: Date.now() - start,
				exportFile: opts.keepExports ? exportFile : undefined,
			};
		}

		// Phase 2: Create stack on target (idempotent)
		// org, project, stackName already computed above with DIY fallbacks

		log.dim("           Creating stack on target...");
		const { created } = await procella.createStack(
			{ url: opts.targetUrl, token: opts.targetToken },
			org,
			project,
			stackName,
		);
		log.dim(`           Stack ${created ? "created" : "already exists"}`);

		// Phase 3: Import state
		log.dim("           Importing state...");
		const { updateId } = await procella.importState(
			{ url: opts.targetUrl, token: opts.targetToken },
			org,
			project,
			stackName,
			deployment,
		);
		log.dim(`           Imported (update ${updateId})`);

		// Phase 4: Verify resource count
		log.dim("           Verifying...");
		const targetState = await procella.exportState(
			{ url: opts.targetUrl, token: opts.targetToken },
			org,
			project,
			stackName,
		);
		const targetResourceCount = targetState.deployment.resources?.length ?? 0;

		if (targetResourceCount !== sourceResourceCount) {
			throw new Error(
				`Resource count mismatch: source=${sourceResourceCount}, target=${targetResourceCount}`,
			);
		}

		// Cleanup export file unless --keep-exports
		if (!opts.keepExports) {
			await rm(exportFile, { force: true });
		}

		const duration = Date.now() - start;
		log.success(`         ${stack.fqn} — ${sourceResourceCount} resources (${duration}ms)`);

		return {
			fqn: stack.fqn,
			status: "succeeded",
			sourceResourceCount,
			targetResourceCount,
			duration,
			exportFile: opts.keepExports ? exportFile : undefined,
		};
	} catch (err) {
		const duration = Date.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		log.error(`         ${stack.fqn} — ${message}`);

		// Clean up export file on failure — contains plaintext secrets
		if (!opts.keepExports) {
			await rm(exportFile, { force: true }).catch(() => {});
		}

		return {
			fqn: stack.fqn,
			status: "failed",
			sourceResourceCount: 0,
			targetResourceCount: null,
			duration,
			error: message,
			exportFile: opts.keepExports ? exportFile : undefined,
		};
	}
}
