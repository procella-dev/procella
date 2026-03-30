import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { SQL } from "bun";
import { getCheckpointBytes, getJournalEntryCount, getLatestUpdateId, getStackId } from "./db-metrics";
import { generateProgram, generateSecretsProgram } from "./generate-programs";
import type { BenchmarkResults, Mode, TrialResult, Variant } from "./types";

const BENCH_PORT = 18_081;
const SYSTEM_PULUMI_HOME = process.env.PULUMI_HOME ?? path.join(process.env.HOME ?? "", ".pulumi");

// ---------------------------------------------------------------------------
// Resolve backend URL + token: BENCH_URL/BENCH_TOKEN → credentials.json → local
// ---------------------------------------------------------------------------

interface PulumiCredentials {
	current?: string;
	accessTokens?: Record<string, string>;
	accounts?: Record<string, { accessToken?: string }>;
}

function readPulumiCredentials(): { url: string; token: string } | null {
	const credPath = path.join(SYSTEM_PULUMI_HOME, "credentials.json");
	if (!existsSync(credPath)) return null;
	try {
		const creds: PulumiCredentials = JSON.parse(readFileSync(credPath, "utf8"));
		const url = creds.current;
		if (!url) return null;
		const token =
			creds.accessTokens?.[url] ?? creds.accounts?.[url]?.accessToken;
		if (!token) return null;
		return { url, token };
	} catch {
		return null;
	}
}

const BENCH_URL = process.env.BENCH_URL;
const BENCH_TOKEN = process.env.BENCH_TOKEN;

// Priority: explicit env → current pulumi login → spin up local server
const resolved: { url: string; token: string; source: "env" | "login" | "local" } = (() => {
	if (BENCH_URL) {
		return { url: BENCH_URL, token: BENCH_TOKEN ?? "benchtoken", source: "env" as const };
	}
	const creds = readPulumiCredentials();
	if (creds) {
		return { url: creds.url, token: BENCH_TOKEN ?? creds.token, source: "login" as const };
	}
	return { url: `http://127.0.0.1:${BENCH_PORT}`, token: BENCH_TOKEN ?? "benchtoken", source: "local" as const };
})();

const BACKEND_URL = resolved.url;
const TEST_TOKEN = resolved.token;
const IS_REMOTE = resolved.source !== "local";
let REMOTE_ORG = "";
const HAS_DB_METRICS = !IS_REMOTE || !!process.env.BENCH_DATABASE_URL;
const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const TEST_DB_URL =
  process.env.BENCH_DATABASE_URL ??
  process.env.PROCELLA_DATABASE_URL ??
  "postgres://procella:procella@localhost:5432/procella?sslmode=disable";

const BENCH_SIZES = (() => {
  const raw = process.env.BENCH_SIZES;
  if (!raw) return [10, 50, 100, 500];
  const parsed = raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.floor(v));
  return parsed.length > 0 ? parsed : [10, 50, 100, 500];
})();

const BENCH_TRIALS = (() => {
  const raw = Number(process.env.BENCH_TRIALS ?? "3");
  if (!Number.isFinite(raw) || raw < 1) return 3;
  return Math.floor(raw);
})();

const IS_CI = !!process.env.GITHUB_ACTIONS;
const STEP_SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY;

const BENCH_MODES: Mode[] = (() => {
  const raw = process.env.BENCH_MODES;
  if (!raw) return ["journal"] as Mode[];
  const parsed = raw.split(",").map((v) => v.trim()).filter((v): v is Mode => v === "checkpoint" || v === "journal");
  return parsed.length > 0 ? parsed : ["journal"] as Mode[];
})();

const BENCH_VARIANTS: Variant[] = (() => {
  const raw = process.env.BENCH_VARIANTS;
  if (!raw) return ["plain", "secrets"] as Variant[];
  const parsed = raw.split(",").map((v) => v.trim()).filter((v): v is Variant => v === "plain" || v === "secrets");
  return parsed.length > 0 ? parsed : ["plain", "secrets"] as Variant[];
})();

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PROCELLA_")) continue;
    if (key.startsWith("AWS_")) continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

async function startBenchServer(): Promise<Subprocess> {
	const proc = Bun.spawn(["bun", "run", "apps/server/src/index.ts"], {
		cwd: PROJECT_ROOT,
		env: {
			...cleanEnv(),
			PROCELLA_LISTEN_ADDR: `:${BENCH_PORT}`,
			PROCELLA_DATABASE_URL: TEST_DB_URL,
			PROCELLA_AUTH_MODE: "dev",
			PROCELLA_DEV_AUTH_TOKEN: TEST_TOKEN,
			PROCELLA_BLOB_BACKEND: "local",
			PROCELLA_BLOB_LOCAL_PATH: "./data/bench-blobs",
			...(process.env.PROCELLA_OTEL_ENABLED
				? { PROCELLA_OTEL_ENABLED: process.env.PROCELLA_OTEL_ENABLED }
				: {}),
		},
		stdout: "ignore",
		stderr: "inherit",
	});

  await waitForHealth(`${BACKEND_URL}/healthz`, 30_000);
  return proc;
}

async function stopBenchServer(proc: Subprocess): Promise<void> {
  proc.kill("SIGTERM");
  await proc.exited;
}

async function resetDb(): Promise<void> {
  const proc = Bun.spawn(["bunx", "drizzle-kit", "migrate", "--config", "packages/db/drizzle.config.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...cleanEnv(),
      PROCELLA_DATABASE_URL: TEST_DB_URL,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(`drizzle-kit migrate failed (exit ${exitCode}): ${stderr}`);
  }
}

async function truncate(): Promise<void> {
  const sql = new SQL({ url: TEST_DB_URL });
  try {
    await sql.unsafe(
      "TRUNCATE update_events, journal_entries, checkpoints, updates, stacks, projects CASCADE",
    );
  } finally {
    sql.close();
  }
}

async function createPulumiHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "procella-bench-pulumi-"));
  const systemPlugins = path.join(SYSTEM_PULUMI_HOME, "plugins");
  const homePlugins = path.join(home, "plugins");

  // Copy plugins (symlink would be fine, but cp -rf is safer for isolation)
  try {
    const cp = Bun.spawn(["cp", "-rf", systemPlugins, homePlugins], {
      stdout: "pipe", stderr: "pipe",
    });
    await cp.exited;
  } catch {}

  // Copy credentials so the CLI can resolve the current backend
  const credSrc = path.join(SYSTEM_PULUMI_HOME, "credentials.json");
  if (existsSync(credSrc)) {
    const cpCred = Bun.spawn(["cp", "-f", credSrc, path.join(home, "credentials.json")], {
      stdout: "pipe", stderr: "pipe",
    });
    await cpCred.exited;
  }

  return home;
}

async function findPulumi(): Promise<string> {
  const fromEnv = process.env.PULUMI_PATH;
  if (fromEnv) return fromEnv;

  const which = Bun.spawn(["mise", "which", "pulumi"], { stdout: "pipe", stderr: "pipe", cwd: PROJECT_ROOT });
  const [exitCode, stdout] = await Promise.all([which.exited, new Response(which.stdout).text()]);
  if (exitCode === 0 && stdout.trim()) return stdout.trim();

  const fallback = Bun.spawn(["which", "pulumi"], { stdout: "pipe", stderr: "pipe" });
  const [fbExit, fbOut] = await Promise.all([fallback.exited, new Response(fallback.stdout).text()]);
  if (fbExit === 0 && fbOut.trim()) return fbOut.trim();

  throw new Error("pulumi not found. Install via mise or set PULUMI_PATH.");
}

let PULUMI_BIN = "";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runPulumi(
  args: string[],
  cwd: string,
  pulumiHome: string,
  mode: Mode = "checkpoint",
  stack?: string,
): Promise<CommandResult> {
  const env: Record<string, string> = {
    ...cleanEnv(),
    PULUMI_CONFIG_PASSPHRASE: "test",
    PULUMI_SKIP_UPDATE_CHECK: "true",
    PULUMI_DIY_BACKEND_URL: "",
    PULUMI_HOME: pulumiHome,
    ...(mode === "journal" ? { PULUMI_ENABLE_JOURNALING: "true" } : { PULUMI_DISABLE_JOURNALING: "true" }),
  };
  if (resolved.source === "login") {
    // Ensure inherited Pulumi auth vars don't override credentials.json
    delete env.PULUMI_ACCESS_TOKEN;
    delete env.PULUMI_BACKEND_URL;
  } else {
    env.PULUMI_ACCESS_TOKEN = TEST_TOKEN;
    env.PULUMI_BACKEND_URL = BACKEND_URL;
  }
  if (stack) env.PULUMI_STACK = stack;

  const proc = Bun.spawn([PULUMI_BIN, ...args, "--non-interactive"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const stdoutDone = (async () => {
    for await (const chunk of proc.stdout) {
      stdoutChunks.push(chunk);
    }
  })();

  const stderrDone = (async () => {
    for await (const chunk of proc.stderr) {
      stderrChunks.push(chunk);
    }
  })();

  const [exitCode] = await Promise.all([proc.exited, stdoutDone, stderrDone]);
  const decoder = new TextDecoder();
  const stdout = stdoutChunks.map((c) => decoder.decode(c, { stream: true })).join("");
  const stderr = stderrChunks.map((c) => decoder.decode(c, { stream: true })).join("");

  if (exitCode !== 0 && IS_REMOTE && (stderr.includes("logging in") || stderr.includes("401") || stderr.includes("Unauthorized"))) {
    console.error(`[AUTH FAILURE] pulumi ${args.join(" ")} → exit=${exitCode}`);
    console.error(`  stderr: ${stderr.slice(0, 300)}`);
    // Verify token is still valid
    try {
      const check = await fetch(`${BACKEND_URL}/api/user`, {
        headers: { Authorization: `token ${TEST_TOKEN}`, Accept: "application/vnd.pulumi+8" },
      });
      console.error(`  Auth re-check: ${check.status} ${(await check.text()).slice(0, 100)}`);
    } catch (e) {
      console.error(`  Auth re-check failed: ${e}`);
    }
  }
  return { exitCode, stdout, stderr };
}

interface TimedResult {
  ms: number | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function timed(fn: () => Promise<CommandResult>): Promise<TimedResult> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  return {
    ms: result.exitCode === 0 ? elapsed : null,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function uniqueId(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function runTrial(
  n: number, mode: Mode, variant: Variant, trial: number, pulumiHome: string,
): Promise<TrialResult> {
  const org = IS_REMOTE ? REMOTE_ORG : "dev-org";
  const project = variant === "secrets" ? "bench-secrets" : "bench";
  const stack = IS_REMOTE ? `t${trial}-${uniqueId()}` : `${variant[0]}${n}`;
  // In login mode, let the CLI resolve the org from credentials — avoids
  // mismatch between display org name and internal tenant ID.
  const stackRef = resolved.source === "login" ? stack : `${org}/${project}/${stack}`;

  if (!IS_REMOTE) {
    await truncate();
  }

  const projectDir = await mkdtemp(path.join(tmpdir(), `procella-bench-${mode}-${variant}-${n}-`));

  try {
    const yaml = variant === "secrets" ? generateSecretsProgram(n) : generateProgram(n);
    await Bun.write(path.join(projectDir, "Pulumi.yaml"), yaml);

    const initResult = await runPulumi(["stack", "init", stackRef], projectDir, pulumiHome, mode);
    if (initResult.exitCode !== 0) {
      return {
        n, mode, variant, trial,
        upMs: null, previewMs: null, destroyMs: null,
        checkpointBytes: null, journalEntryCount: null,
        upExitCode: initResult.exitCode,
        previewExitCode: null, destroyExitCode: null,
        upStderr: `stack init failed: ${initResult.stderr}`,
        previewStderr: "", destroyStderr: "",
      };
    }

    const up = await timed(() => runPulumi(["up", "--yes"], projectDir, pulumiHome, mode, stack));

    if (up.exitCode !== 0) {
      console.error(`[${mode}/${variant}] N=${n} trial=${trial} up failed (exit ${up.exitCode}):\n  stdout: ${up.stdout.slice(0, 500)}\n  stderr: ${up.stderr.slice(0, 500)}`);
      return {
        n, mode, variant, trial,
        upMs: null, previewMs: null, destroyMs: null,
        checkpointBytes: null, journalEntryCount: null,
        upExitCode: up.exitCode,
        previewExitCode: null, destroyExitCode: null,
        upStderr: up.stderr, previewStderr: "", destroyStderr: "",
      };
    }

    const preview = await timed(() => runPulumi(["preview"], projectDir, pulumiHome, mode, stack));

    let checkpointBytes: number | null = null;
    let journalEntryCount: number | null = null;
    if (HAS_DB_METRICS) {
      const updateId = await getLatestUpdateId(org, project, stack);
      const stackId = await getStackId(org, project, stack);
      checkpointBytes = stackId ? await getCheckpointBytes(stackId) : null;
      journalEntryCount = updateId ? await getJournalEntryCount(updateId) : null;
    }

    const destroy = await timed(() => runPulumi(["destroy", "--yes"], projectDir, pulumiHome, mode, stack));

    return {
      n, mode, variant, trial,
      upMs: up.ms, previewMs: preview.ms, destroyMs: destroy.ms,
      checkpointBytes, journalEntryCount,
      upExitCode: up.exitCode,
      previewExitCode: preview.exitCode, destroyExitCode: destroy.exitCode,
      upStderr: up.stderr, previewStderr: preview.stderr, destroyStderr: destroy.stderr,
    };
  } finally {
    if (IS_REMOTE) {
      await runPulumi(["stack", "rm", "--yes"], projectDir, pulumiHome, mode).catch(() => {});
    }
    await rm(projectDir, { recursive: true, force: true });
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

function formatMs(value: number | null): string {
  return value === null ? "FAIL" : `${value.toFixed(1)}ms`;
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? "FAIL" : value.toFixed(digits);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function stddev(values: number[]): number | null {
  const avg = average(values);
  if (avg === null || values.length < 2) return null;
  const sumSq = values.reduce((acc, v) => acc + (v - avg) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

async function writeStepSummary(results: BenchmarkResults): Promise<void> {
  if (!STEP_SUMMARY_PATH) return;

  const modes = [...new Set(results.results.map((r) => r.mode))];
  const variants = [...new Set(results.results.map((r) => r.variant))];
  const lines: string[] = [];

  lines.push("### 📊 Benchmark Results");
  lines.push("");
  lines.push(`> ${results.trialsPerSize} trials per combo · modes: ${modes.join(", ")} · sizes: ${results.benchSizes.join(", ")}`);
  lines.push("");
  lines.push("| N | Mode | Variant | up p50 | up σ | up min | up max | preview p50 | destroy p50 |");
  lines.push("|---:|------|---------|-------:|-----:|-------:|-------:|------------:|------------:|");

  for (const n of results.benchSizes) {
    for (const mode of modes) {
      for (const variant of variants) {
        const rows = results.results.filter((r) => r.n === n && r.mode === mode && r.variant === variant);
        const successful = rows.filter((r) => r.upExitCode === 0);
        if (successful.length === 0) {
          lines.push(`| ${n} | ${mode} | ${variant} | ❌ FAIL | — | — | — | — | — |`);
          continue;
        }
        const upVals = successful.map((r) => r.upMs).filter((v): v is number => typeof v === "number");
        const preVals = successful.map((r) => r.previewMs).filter((v): v is number => typeof v === "number");
        const desVals = successful.map((r) => r.destroyMs).filter((v): v is number => typeof v === "number");
        const upSd = stddev(upVals);
        lines.push(
          `| ${n} | ${mode} | ${variant} | ${formatMs(median(upVals))} | ${upSd !== null ? formatMs(upSd) : "—"} | ${formatMs(upVals.length > 0 ? Math.min(...upVals) : null)} | ${formatMs(upVals.length > 0 ? Math.max(...upVals) : null)} | ${formatMs(median(preVals))} | ${formatMs(median(desVals))} |`,
        );
      }
    }
  }

  lines.push("");
  lines.push("<details><summary>Per-trial breakdown</summary>");
  lines.push("");
  lines.push("| N | Mode | Variant | Trial | up | preview | destroy |");
  lines.push("|---:|------|---------|------:|---:|--------:|--------:|");
  for (const r of results.results) {
    const status = r.upExitCode === 0 ? "" : " ❌";
    lines.push(
      `| ${r.n} | ${r.mode} | ${r.variant} | ${r.trial} | ${formatMs(r.upMs)}${status} | ${formatMs(r.previewMs)} | ${formatMs(r.destroyMs)} |`,
    );
  }
  lines.push("");
  lines.push("</details>");

  await Bun.write(STEP_SUMMARY_PATH, `${lines.join("\n")}\n`);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : `${" ".repeat(width - s.length)}${s}`;
}

function renderSummary(results: BenchmarkResults): string {
  const modes = [...new Set(results.results.map((r) => r.mode))];
  const variants = [...new Set(results.results.map((r) => r.variant))];
  const combos: Array<{ n: number; mode: Mode; variant: Variant }> = [];
  for (const n of results.benchSizes) {
    for (const mode of modes) {
      for (const variant of variants) {
        combos.push({ n, mode, variant });
      }
    }
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("━".repeat(78));
  lines.push("  BENCHMARK SUMMARY");
  lines.push("━".repeat(78));

  for (const combo of combos) {
    const rows = results.results.filter(
      (r) => r.n === combo.n && r.mode === combo.mode && r.variant === combo.variant,
    );
    const successful = rows.filter((r) => r.upExitCode === 0);

    lines.push("");
    lines.push(`  ${combo.mode}/${combo.variant}  N=${combo.n}`);
    lines.push(`  ${"─".repeat(50)}`);

    if (successful.length === 0) {
      lines.push("    ✗ ALL TRIALS FAILED");
      continue;
    }

    const upValues = successful.map((r) => r.upMs).filter((v): v is number => typeof v === "number");
    const previewValues = successful.map((r) => r.previewMs).filter((v): v is number => typeof v === "number");
    const destroyValues = successful.map((r) => r.destroyMs).filter((v): v is number => typeof v === "number");
    const journalValues = successful.map((r) => r.journalEntryCount).filter((v): v is number => typeof v === "number");

    const upP50 = median(upValues);
    const upMin = upValues.length > 0 ? Math.min(...upValues) : null;
    const upMax = upValues.length > 0 ? Math.max(...upValues) : null;
    const previewP50 = median(previewValues);
    const destroyP50 = median(destroyValues);
    const avgJournal = average(journalValues);

    const upStd = stddev(upValues);
    const stdText = upStd !== null ? `, σ=${formatMs(upStd)}` : "";
    lines.push(`    up      ${padLeft(formatMs(upP50), 10)}  (min ${formatMs(upMin)}, max ${formatMs(upMax)}${stdText})`);
    lines.push(`    preview ${padLeft(formatMs(previewP50), 10)}`);
    lines.push(`    destroy ${padLeft(formatMs(destroyP50), 10)}`);
    if (avgJournal !== null) {
      lines.push(`    journal ${padLeft(formatNumber(avgJournal, 0), 10)} entries`);
    }
  }

  lines.push("");
  lines.push("━".repeat(78));
  return lines.join("\n");
}

async function main(): Promise<void> {
  PULUMI_BIN = await findPulumi();
  console.log(`Procella benchmark: modes=${BENCH_MODES.join(",")}, variants=${BENCH_VARIANTS.join(",")}, sizes=${BENCH_SIZES.join(",")}, trials=${BENCH_TRIALS}`);
  console.log(`Using pulumi: ${PULUMI_BIN}`);
  console.log(`Backend: ${BACKEND_URL} (${resolved.source})`);

  if (!IS_REMOTE) {
    await resetDb();
  }
  const pulumiHome = await createPulumiHome();

  if (IS_REMOTE) {
    if (resolved.source === "login") {
      // Use `pulumi whoami` to get the org the CLI actually uses (matches backend)
      const whoami = await runPulumi(["whoami", "--json"], PROJECT_ROOT, pulumiHome);
      if (whoami.exitCode !== 0) {
        throw new Error(`pulumi whoami failed (exit ${whoami.exitCode}): ${whoami.stderr}`);
      }
      const info = JSON.parse(whoami.stdout) as { user?: string; organizations?: string[] };
      REMOTE_ORG = info.organizations?.[0] ?? info.user ?? "";
    } else {
      // Explicit BENCH_URL: detect org from the API
      const userRes = await fetch(`${BACKEND_URL}/api/user`, {
        headers: { Authorization: `token ${TEST_TOKEN}`, Accept: "application/vnd.pulumi+8" },
      });
      if (!userRes.ok) {
        const body = await userRes.text();
        throw new Error(`Auth check failed (${userRes.status}): ${body}`);
      }
      const userInfo = (await userRes.json()) as { organizations?: Array<{ githubLogin: string }> };
      REMOTE_ORG = userInfo.organizations?.[0]?.githubLogin ?? "";
    }
    if (!REMOTE_ORG) {
      throw new Error("Could not determine org. Check your pulumi login or BENCH_URL/BENCH_TOKEN.");
    }
    console.log(`  Org: ${REMOTE_ORG}`);
    console.log(`  DB metrics: ${HAS_DB_METRICS ? "enabled" : "disabled"}`);
  }
  const allResults: TrialResult[] = [];

  try {
    const variants = BENCH_VARIANTS;

    let server: Subprocess | null = null;
    if (!IS_REMOTE) {
      server = await startBenchServer();
    }
    try {
      for (const mode of BENCH_MODES) {
        for (const variant of variants) {
          for (const n of BENCH_SIZES) {
            if (IS_CI) console.log(`::group::${mode}/${variant} N=${n}`);
            for (let trial = 1; trial <= BENCH_TRIALS; trial += 1) {
              const label = `  [${mode}/${variant}] N=${n} trial=${trial}`;
              process.stdout.write(`${label} ...`);
              const result = await runTrial(n, mode, variant, trial, pulumiHome);
              allResults.push(result);
              if (result.upExitCode !== 0) {
                console.log(` FAIL (exit ${result.upExitCode})`);
              } else {
                const up = result.upMs !== null ? `up=${formatMs(result.upMs)}` : "up=N/A";
                const preview = result.previewMs !== null ? `preview=${formatMs(result.previewMs)}` : "";
                const destroy = result.destroyMs !== null ? `destroy=${formatMs(result.destroyMs)}` : "";
                console.log(` ${[up, preview, destroy].filter(Boolean).join("  ")}`);
              }
            }
            if (IS_CI) console.log("::endgroup::");
          }
        }
      }
    } finally {
      if (server) {
        await stopBenchServer(server);
      }
    }

    const payload: BenchmarkResults = {
      runAt: new Date().toISOString(),
      benchSizes: BENCH_SIZES,
      trialsPerSize: BENCH_TRIALS,
      results: allResults,
    };

    await mkdir(import.meta.dir, { recursive: true });
    await Bun.write(path.join(import.meta.dir, "results.json"), JSON.stringify(payload, null, 2));

    console.log(renderSummary(payload));
    await writeStepSummary(payload);
  } finally {
    await rm(pulumiHome, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
