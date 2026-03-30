#!/usr/bin/env bun
/**
 * PROCELLA_URL           Backend URL (omit to use current `pulumi login`)
 * PULUMI_ACCESS_TOKEN    Auth token  (omit to use stored credentials)
 * LOAD_CYCLES            Up/destroy cycles per worker   (default: 4)
 * LOAD_WORKERS           Workers per example program    (default: 1)
 * LOAD_EXAMPLES          Comma-separated example names  (default: all safe)
 * LOAD_STAGGER_MS        Stagger between worker launches in ms (default: 0)
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const SYSTEM_PULUMI_HOME = process.env.PULUMI_HOME ?? join(process.env.HOME ?? "", ".pulumi");

const PROCELLA_URL = process.env.PROCELLA_URL;
const ACCESS_TOKEN = process.env.PULUMI_ACCESS_TOKEN;
const CYCLES = Math.max(1, Number(process.env.LOAD_CYCLES ?? "4"));
const WORKERS_PER_EXAMPLE = Math.max(1, Number(process.env.LOAD_WORKERS ?? "1"));
const STAGGER_MS = Math.max(0, Number(process.env.LOAD_STAGGER_MS ?? "0"));
const EXAMPLES_DIR = resolve(PROJECT_ROOT, "examples");

// Skip: protect (can't destroy protected resources), stack-ref (cross-stack dependency)
const ALL_SAFE_EXAMPLES = [
	"multi-resource", // 12 resources, mixed types
	"component", // cross-group dependencies
	"secrets-heavy", // encrypted config + secret outputs
	"large-state", // 80 resources stress test
	"replace-triggers", // command provider, replacement lifecycle
] as const;

const EXAMPLES: string[] = (() => {
	const raw = process.env.LOAD_EXAMPLES;
	if (!raw) return [...ALL_SAFE_EXAMPLES];
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parsed.length === 0) return [...ALL_SAFE_EXAMPLES];
	const missing = parsed.filter((name) => !existsSync(join(EXAMPLES_DIR, name)));
	if (missing.length > 0) {
		console.error(
			`LOAD_EXAMPLES: directories not found: ${missing.join(", ")}. Available: ${ALL_SAFE_EXAMPLES.join(", ")}`,
		);
		process.exit(1);
	}
	return parsed;
})();

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

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PROCELLA_")) continue;
		if (key.startsWith("AWS_")) continue;
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function createWorkerHome(): string {
	const home = mkdtempSync(join(tmpdir(), "load-pulumi-"));
	const credSrc = join(SYSTEM_PULUMI_HOME, "credentials.json");
	if (existsSync(credSrc)) cpSync(credSrc, join(home, "credentials.json"));
	const pluginsSrc = join(SYSTEM_PULUMI_HOME, "plugins");
	if (existsSync(pluginsSrc)) cpSync(pluginsSrc, join(home, "plugins"), { recursive: true });
	return home;
}

async function findPulumi(): Promise<string> {
	const fromEnv = process.env.PULUMI_PATH;
	if (fromEnv) return fromEnv;

	const mise = Bun.spawn(["mise", "which", "pulumi"], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: PROJECT_ROOT,
	});
	const [miseExit, miseOut] = await Promise.all([mise.exited, new Response(mise.stdout).text()]);
	if (miseExit === 0 && miseOut.trim()) return miseOut.trim();

	const which = Bun.spawn(["which", "pulumi"], { stdout: "pipe", stderr: "pipe" });
	const [whichExit, whichOut] = await Promise.all([
		which.exited,
		new Response(which.stdout).text(),
	]);
	if (whichExit === 0 && whichOut.trim()) return whichOut.trim();

	throw new Error("pulumi not found. Install via mise or set PULUMI_PATH.");
}

let PULUMI_BIN = "";

async function pulumi(
	args: string[],
	opts: { cwd: string; pulumiHome: string },
): Promise<{ exit: number; stdout: string; stderr: string }> {
	const env: Record<string, string> = {
		...cleanEnv(),
		PULUMI_HOME: opts.pulumiHome,
		PULUMI_SKIP_UPDATE_CHECK: "true",
		PULUMI_DIY_BACKEND_URL: "",
	};
	delete env.PULUMI_BACKEND_URL;
	delete env.PULUMI_ACCESS_TOKEN;
	if (PROCELLA_URL) env.PULUMI_BACKEND_URL = PROCELLA_URL;
	if (ACCESS_TOKEN) env.PULUMI_ACCESS_TOKEN = ACCESS_TOKEN;

	const proc = Bun.spawn([PULUMI_BIN, ...args, "--non-interactive"], {
		cwd: opts.cwd,
		env,
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

	const pulumiHome = createWorkerHome();
	const isolatedDir = mkdtempSync(join(tmpdir(), `load-${example}-`));
	cpSync(join(EXAMPLES_DIR, example), isolatedDir, { recursive: true });

	const run = (args: string[]) => pulumi(args, { cwd: isolatedDir, pulumiHome });
	const cycles: CycleResult[] = [];

	try {
		console.log(`${tag} stack init ${stackName}`);
		const init = await run(["stack", "init", stackName]);
		if (init.exit !== 0) {
			const msg = `stack init failed (exit ${init.exit}): ${init.stderr.slice(0, 300)}`;
			console.error(`${tag} \x1b[31mFAILED\x1b[0m ${msg}`);
			return { example, worker: workerId, stack: stackName, cycles, totalMs: performance.now() - start, ok: false, error: msg };
		}

		for (let c = 0; c < CYCLES; c++) {
			let upMs = 0;
			let destroyMs = 0;
			let upOk = false;
			let destroyOk = false;
			let error: string | undefined;
			let upAttempted = false;

			try {
				const t0 = performance.now();
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: up`);
				upAttempted = true;
				const up = await run(["up", "--yes", "--skip-preview"]);
				upMs = performance.now() - t0;
				upOk = up.exit === 0;
				if (!upOk) {
					throw new Error(`up exit=${up.exit}: ${up.stderr.slice(0, 300)}`);
				}
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: up \x1b[32m✓\x1b[0m ${fmtMs(upMs)}`);

				const t1 = performance.now();
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: destroy`);
				const des = await run(["destroy", "--yes", "--skip-preview"]);
				destroyMs = performance.now() - t1;
				destroyOk = des.exit === 0;
				if (!destroyOk) {
					throw new Error(`destroy exit=${des.exit}: ${des.stderr.slice(0, 300)}`);
				}
				console.log(`${tag} cycle ${c + 1}/${CYCLES}: destroy \x1b[32m✓\x1b[0m ${fmtMs(destroyMs)}`);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
				console.error(`${tag} cycle ${c + 1}/${CYCLES}: \x1b[31mFAILED\x1b[0m ${error}`);
				if (upAttempted && !destroyOk) {
					console.log(`${tag} cycle ${c + 1}/${CYCLES}: best-effort destroy`);
					await run(["destroy", "--yes", "--skip-preview"]).catch(() => {});
				}
			}

			cycles.push({ cycle: c + 1, upMs, destroyMs, upOk, destroyOk, error });
		}

		console.log(`${tag} stack rm ${stackName}`);
		const rm = await run(["stack", "rm", "--yes", stackName]);
		if (rm.exit !== 0) {
			console.error(`${tag} stack rm failed (exit ${rm.exit}): ${rm.stderr.slice(0, 200)}`);
		}
	} finally {
		rmSync(pulumiHome, { recursive: true, force: true });
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

function printSummary(results: WorkerResult[], wallClockMs?: number): void {
	const total = results.length;
	const passed = results.filter((r) => r.ok).length;
	const failed = total - passed;

	const lines: string[] = [];
	lines.push("");
	lines.push("\x1b[1m" + "━".repeat(80) + "\x1b[0m");
	lines.push("\x1b[1m  LOAD TEST RESULTS\x1b[0m");
	lines.push("\x1b[1m" + "━".repeat(80) + "\x1b[0m");
	lines.push("");
	lines.push(
		`  Workers: ${total}  |  Passed: \x1b[32m${passed}\x1b[0m  |  Failed: ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : "0"}`,
	);
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

	const elapsed = wallClockMs ?? Math.max(...results.map((r) => r.totalMs), 0);
	lines.push("");
	lines.push(`  Wall clock: ${fmtMs(elapsed)}`);
	lines.push("\x1b[1m" + "━".repeat(80) + "\x1b[0m");

	for (const line of lines) console.log(line);
}

async function main(): Promise<void> {
	PULUMI_BIN = await findPulumi();
	const totalWorkers = EXAMPLES.length * WORKERS_PER_EXAMPLE;

	console.log("\x1b[1mProcella load test\x1b[0m");
	console.log(`  Pulumi:   ${PULUMI_BIN}`);
	console.log(`  Backend:  ${PROCELLA_URL ?? "(current pulumi login)"}`);
	console.log(`  Examples: ${EXAMPLES.join(", ")}`);
	console.log(`  Workers:  ${WORKERS_PER_EXAMPLE} per example (${totalWorkers} total)`);
	console.log(`  Cycles:   ${CYCLES} up/destroy per worker`);
	if (STAGGER_MS > 0) console.log(`  Stagger:  ${STAGGER_MS}ms between launches`);
	console.log("");

	const mainStart = performance.now();
	const promises: Promise<WorkerResult>[] = [];
	let delay = 0;

	for (const example of EXAMPLES) {
		for (let w = 0; w < WORKERS_PER_EXAMPLE; w++) {
			if (delay > 0) {
				const d = delay;
				promises.push(
					new Promise<WorkerResult>((resolve) =>
						setTimeout(() => resolve(runWorker(example, w)), d),
					),
				);
			} else {
				promises.push(runWorker(example, w));
			}
			delay += STAGGER_MS;
		}
	}

	const settled = await Promise.allSettled(promises);
	const wallClockMs = performance.now() - mainStart;

	const completed: WorkerResult[] = [];
	for (const r of settled) {
		if (r.status === "fulfilled") {
			completed.push(r.value);
		} else {
			console.error(`\x1b[31mWorker crashed:\x1b[0m ${r.reason}`);
		}
	}

	printSummary(completed, wallClockMs);

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
