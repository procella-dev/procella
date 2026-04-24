import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditLog, MigrationResult } from "./types.js";

export function createAuditLog(source: string, target: string): AuditLog {
	return {
		runId: `mig_${new Date().toISOString().replace(/[:.]/g, "-")}`,
		source,
		target,
		startedAt: new Date().toISOString(),
		completedAt: null,
		stacks: [],
		summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
	};
}

export function recordResult(log: AuditLog, result: MigrationResult): void {
	log.stacks.push(result);
	log.summary.total++;
	log.summary[result.status]++;
}

export function finalizeAuditLog(log: AuditLog): void {
	log.completedAt = new Date().toISOString();
}

export async function writeAuditLog(log: AuditLog, dir: string): Promise<string> {
	const filename = `${log.runId}.json`;
	const filepath = join(dir, filename);
	await writeFile(filepath, JSON.stringify(log, null, 2), "utf-8");
	return filepath;
}
