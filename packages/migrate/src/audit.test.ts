import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog, finalizeAuditLog, recordResult, writeAuditLog } from "./audit.js";
import type { MigrationResult } from "./types.js";

describe("createAuditLog", () => {
	test("initializes with correct structure", () => {
		const log = createAuditLog("https://source.com", "https://target.com");

		expect(log.source).toBe("https://source.com");
		expect(log.target).toBe("https://target.com");
		expect(log.runId).toMatch(/^mig_/);
		expect(log.startedAt).toBeTruthy();
		expect(log.completedAt).toBeNull();
		expect(log.stacks).toEqual([]);
		expect(log.summary).toEqual({ total: 0, succeeded: 0, failed: 0, skipped: 0 });
	});
});

describe("recordResult", () => {
	test("appends result and increments counters", () => {
		const log = createAuditLog("src", "tgt");

		const success: MigrationResult = {
			fqn: "org/proj/dev",
			status: "succeeded",
			sourceResourceCount: 10,
			targetResourceCount: 10,
			duration: 500,
		};
		recordResult(log, success);

		expect(log.stacks).toHaveLength(1);
		expect(log.summary.total).toBe(1);
		expect(log.summary.succeeded).toBe(1);

		const failure: MigrationResult = {
			fqn: "org/proj/prod",
			status: "failed",
			sourceResourceCount: 20,
			targetResourceCount: null,
			duration: 100,
			error: "connection refused",
		};
		recordResult(log, failure);

		expect(log.stacks).toHaveLength(2);
		expect(log.summary.total).toBe(2);
		expect(log.summary.failed).toBe(1);
	});

	test("tracks skipped stacks", () => {
		const log = createAuditLog("src", "tgt");
		recordResult(log, {
			fqn: "org/proj/skip",
			status: "skipped",
			sourceResourceCount: 5,
			targetResourceCount: null,
			duration: 0,
		});
		expect(log.summary.skipped).toBe(1);
	});

	test("abort path: total matches filtered count when skipping remaining stacks", () => {
		const log = createAuditLog("src", "tgt");
		const filtered = [
			{ fqn: "org/proj/dev", status: "succeeded" as const },
			{ fqn: "org/proj/staging", status: "failed" as const },
			{ fqn: "org/proj/prod", status: "skipped" as const },
		];
		for (const { fqn, status } of filtered) {
			recordResult(log, {
				fqn,
				status,
				sourceResourceCount: 0,
				targetResourceCount: null,
				duration: 0,
			});
		}
		expect(log.summary.total).toBe(3);
		expect(log.summary.succeeded).toBe(1);
		expect(log.summary.failed).toBe(1);
		expect(log.summary.skipped).toBe(1);
		expect(log.stacks).toHaveLength(3);
	});
});

describe("finalizeAuditLog", () => {
	test("sets completedAt timestamp", () => {
		const log = createAuditLog("src", "tgt");
		expect(log.completedAt).toBeNull();

		finalizeAuditLog(log);
		expect(log.completedAt).toBeTruthy();
		expect(typeof log.completedAt).toBe("string");
	});
});

describe("writeAuditLog", () => {
	test("writes JSON file to disk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "audit-test-"));
		try {
			const log = createAuditLog("src", "tgt");
			recordResult(log, {
				fqn: "org/proj/dev",
				status: "succeeded",
				sourceResourceCount: 5,
				targetResourceCount: 5,
				duration: 200,
			});
			finalizeAuditLog(log);

			const filepath = await writeAuditLog(log, dir);
			expect(filepath).toContain(log.runId);

			const content = await readFile(filepath, "utf-8");
			const parsed = JSON.parse(content);
			expect(parsed.runId).toBe(log.runId);
			expect(parsed.stacks).toHaveLength(1);
			expect(parsed.summary.succeeded).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("uses platform path separator (not hardcoded /)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "audit-sep-"));
		try {
			const log = createAuditLog("src", "tgt");
			finalizeAuditLog(log);
			const dirWithTrailing = `${dir}${dir.endsWith("/") ? "" : "/"}`;
			const filepath = await writeAuditLog(log, dirWithTrailing);
			expect(filepath).not.toMatch(/\/\//);
			expect(filepath).toContain(log.runId);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
