#!/usr/bin/env bun
/**
 * PROCELLA_URL           Backend URL (omit to use current `pulumi login`)
 * PULUMI_ACCESS_TOKEN    Auth token  (omit to use stored credentials)
 * LOAD_CYCLES            Up/destroy cycles per worker   (default: 4)
 * LOAD_WORKERS           Workers per example program    (default: 1)
 * LOAD_EXAMPLES          Comma-separated example names  (default: all safe)
 * LOAD_STAGGER_MS        Stagger between worker launches in ms (default: 0)
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const PROCELLA_URL = process.env.PROCELLA_URL;
const ACCESS_TOKEN = process.env.PULUMI_ACCESS_TOKEN;
const CYCLES = Math.max(1, Number(process.env.LOAD_CYCLES ?? "4"));
const WORKERS_PER_EXAMPLE = Math.max(1, Number(process.env.LOAD_WORKERS ?? "1"));
const STAGGER_MS = Math.max(0, Number(process.env.LOAD_STAGGER_MS ?? "0"));
const EXAMPLES_DIR = resolve(import.meta.dir, "..", "examples");

// Safe for load testing — no protected resources, no cross-stack deps.
const ALL_SAFE_EXAMPLES = [
	"multi-resource", // 12 resources, mixed types
	"component", //      cross-group dependencies
	"secrets-heavy", //  encrypted config + secret outputs
	"large-state", //    80 resources — stress test
	"replace-triggers", // command provider, replacement lifecycle
] as const;

const EXAMPLES: string[] = process.env.LOAD_EXAMPLES
	? process.env.LOAD_EXAMPLES.split(",").map((s) => s.trim())
	: [...ALL_SAFE_EXAMPLES];

interface CycleResult {
	cycle: number;
	upMs: number;
	destroyMs: number;
	upOk: boolean;
	destroyOk: boolean;
	error?: string;
}

interface WorkerResult {
	example: string;
	worker: number;
	stack: string;
	cycles: CycleResult[];
	totalMs: number;
	ok: boolean;
	error?: string;
}

async function pulumi(
	args: string[],
	opts: { cwd: string },
): Promise<{ exit: number; stdout: string; stderr: string }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PULUMI_SKIP_UPDATE_CHECK: "true",
		PULUMI_DIY_BACKEND_URL: "",
	};
	if (PROCELLA_URL) env.PULUMI_BACKEND_URL = PROCELLA_URL;
	if (ACCESS_TOKEN) env.PULUMI_ACCESS_TOKEN = ACCESS_TOKEN;

	const proc = Bun.spawn(["pulumi", ...args, "--non-interactive"], {
		cwd: opts.cwd,
		env: env as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [exit, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	return { exit, stdout, stderr };
}

async function runWorker(example: string, workerId: number): Promise<WorkerResult> {
	const id = randomBytes(4).toString("hex");
	const stackName = `load-${id}`;
	const tag = `\x1b[36m[${example}#${workerId}]\x1b[0m`;
	const start = performance.now();

	const isolatedDir = mkdtempSync(join(tmpdir(), `load-${example}-`));
	cpSync(join(EXAMPLES_DIR, example), isolatedDir, { recursive: true });

	const cycles: CycleResult[] = [];

	try {
		console.log(`${tag} stack init ${stackName}`);
		const init = await pulumi(["stack", "init", stackName], { cwd: isolatedDir });
		if (init.exit !== 0) {
			throw new Error(`stack init failed (exit ${init.exit}): ${init.stderr.slice(0, 300)}`);
		}

		for (let c = 0; c < CYCLES; c++) {
			let upMs = 0;
			let destroyMs = 0;
			let upOk = false;
			let destroyOk = false;
			let error: string | undefined;

			try {
				const t0 = performance.now();
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: up`);
				const up = await pulumi(["up", "--yes", "--skip-preview", "--stack", stackName], {
					cwd: isolatedDir,
				});
				upMs = performance.now() - t0;
				upOk = up.exit === 0;
				if (!upOk) {
					throw new Error(`up exit=${up.exit}: ${up.stderr.slice(0, 300)}`);
				}
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: up \x1b[32m✓\x1b[0m ${fmtMs(upMs)}`);

				const t1 = performance.now();
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: destroy`);
				const des = await pulumi(["destroy", "--yes", "--skip-preview", "--stack", stackName], {
					cwd: isolatedDir,
				});
				destroyMs = performance.now() - t1;
				destroyOk = des.exit === 0;
				if (!destroyOk) {
					throw new Error(`destroy exit=${des.exit}: ${des.stderr.slice(0, 300)}`);
				}
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: destroy \x1b[32m✓\x1b[0m ${fmtMs(destroyMs)}`);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
				console.error(`${tag} cycle ${c + 1}/${CYCLES}: \x1b[31mFAILED\x1b[0m ${error}`);
			}

			cycles.push({ cycle: c + 1, upMs, destroyMs, upOk, destroyOk, error });
		}

		console.log(`${tag} stack rm ${stackName}`);
		await pulumi(["stack", "rm", "--yes", "--stack", stackName], { cwd: isolatedDir });
	} finally {
		rmSync(isolatedDir, { recursive: true, force: true });
	}

	const totalMs = performance.now() - start;
	const ok = cycles.every((c) => c.upOk && c.destroyOk);
	return { example, worker: workerId, stack: stackName, cycles, totalMs, ok };
}

function fmtMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function rpad(s: string, n: number): string {
	return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function percentile(sorted: number[], pct: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(Math.floor(sorted.length * pct), sorted.length - 1);
	return sorted[idx];
}

function printSummary(results: WorkerResult[]): void {
	const total = results.length;
	const passed = results.filter((r) => r.ok).length;
	const failed = total - passed;

	const lines: string[] = [];
	lines.push("");
	lines.push("\x1b[1m" + "━".repeat(80) + "\x1b[0m");
	lines.push("\x1b[1m  LOAD TEST RESULTS\x1b[0m");
	lines.push("\x1b[1m" + "━".repeat(80) + "\x1b[0m");
	lines.push("");
	lines.push(`  Workers: ${total}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : "0"}`);
	lines.push(`  Cycles per worker: ${CYCLES}`);
	lines.push("");

	lines.push(
		`  ${pad("Example", 20)} ${rpad("up p50", 8)} ${rpad("up p99", 8)} ${rpad("des p50", 8)} ${rpad("des p99", 8)} ${rpad("status", 6)}`,
	);
	lines.push(`  ${"─".repeat(70)}`);

	const byExample = new Map<string, WorkerResult[]>();
	for (const r of results) {
		const list = byExample.get(r.example) ?? [];
		list.push(r);
		byExample.set(r.example, list);
	}

	for (const [example, workers] of byExample) {
		const ups = workers
			.flatMap((w) => w.cycles.filter((c) => c.upOk).map((c) => c.upMs))
			.sort((a, b) => a - b);
		const destroys = workers
			.flatMap((w) => w.cycles.filter((c) => c.destroyOk).map((c) => c.destroyMs))
			.sort((a, b) => a - b);

		const allOk = workers.every((w) => w.ok);
		const status = allOk ? "\x1b[32m  ✓\x1b[0m" : "\x1b[31m  ✗\x1b[0m";

		lines.push(
			`  ${pad(example, 20)} ${rpad(fmtMs(percentile(ups, 0.5)), 8)} ${rpad(fmtMs(percentile(ups, 0.99)), 8)} ${rpad(fmtMs(percentile(destroys, 0.5)), 8)} ${rpad(fmtMs(percentile(destroys, 0.99)), 8)} ${status}`,
		);
	}

	const maxTotal = Math.max(...results.map((r) => r.totalMs), 0);
	lines.push("");
	lines.push(`  Wall clock: ${fmtMs(maxTotal)}`);
	lines.push("\x1b[1m" + "━".repeat(80) + "\x1b[0m");

	for (const line of lines) console.log(line);
}

async function main(): Promise<void> {
	const totalWorkers = EXAMPLES.length * WORKERS_PER_EXAMPLE;

	console.log("\x1b[1mProcella load test\x1b[0m");
	console.log(`  Backend:  ${PROCELLA_URL ?? "(current pulumi login)"}`);
	console.log(`  Examples: ${EXAMPLES.join(", ")}`);
	console.log(`  Workers:  ${WORKERS_PER_EXAMPLE} per example (${totalWorkers} total)`);
	console.log(`  Cycles:   ${CYCLES} up/destroy per worker`);
	if (STAGGER_MS > 0) console.log(`  Stagger:  ${STAGGER_MS}ms between launches`);
	console.log("");

	const promises: Promise<WorkerResult>[] = [];
	let delay = 0;

	for (const example of EXAMPLES) {
		for (let w = 0; w < WORKERS_PER_EXAMPLE; w++) {
			if (delay > 0) {
				const d = delay;
				promises.push(
					new Promise<WorkerResult>((resolve) => setTimeout(() => resolve(runWorker(example, w)), d)),
				);
			} else {
				promises.push(runWorker(example, w));
			}
			delay += STAGGER_MS;
		}
	}

	const settled = await Promise.allSettled(promises);

	const completed: WorkerResult[] = [];
	for (const r of settled) {
		if (r.status === "fulfilled") {
			completed.push(r.value);
		} else {
			console.error(`\x1b[31mWorker crashed:\x1b[0m ${r.reason}`);
		}
	}

	printSummary(completed);

	const outPath = join(import.meta.dir, "load-results.json");
	await Bun.write(
		outPath,
		JSON.stringify(
			{
				runAt: new Date().toISOString(),
				config: {
					backendUrl: PROCELLA_URL ?? null,
					cycles: CYCLES,
					workersPerExample: WORKERS_PER_EXAMPLE,
					examples: EXAMPLES,
				},
				results: completed,
			},
			null,
			2,
		),
	);
	console.log(`\nResults: ${outPath}`);

	if (completed.some((r) => !r.ok) || completed.length < totalWorkers) {
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
