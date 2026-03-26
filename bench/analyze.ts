import path from "node:path";
import type { BaselineConfig, BenchmarkResults, Mode, TrialResult, Variant } from "./types";

interface ComboSummary {
  n: number;
  mode: Mode;
  variant: Variant;
  p50: number | null;
  threshold: number;
  limit: number;
  pass: boolean;
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

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function groupKey(n: number, mode: Mode, variant: Variant): string {
  return `${n}::${mode}/${variant}`;
}

function getUpValues(rows: TrialResult[]): number[] {
  return rows.map((r) => r.upMs).filter((value): value is number => typeof value === "number");
}

async function main(): Promise<void> {
  const resultsPath = path.join(import.meta.dir, "results.json");
  const baselinePath = path.join(import.meta.dir, "baseline.json");

  const [results, baseline] = await Promise.all([
    Bun.file(resultsPath).json() as Promise<BenchmarkResults>,
    Bun.file(baselinePath).json() as Promise<BaselineConfig>,
  ]);

  const tolerancePct = baseline.tolerancePct ?? 20;

  const failedTrials = results.results.filter((row) => row.upExitCode !== 0);
  if (failedTrials.length > 0) {
    const details = failedTrials.map((row) => `${row.mode}/${row.variant} n=${row.n} trial=${row.trial} exit=${row.upExitCode}`).join("\n");
    console.error("Benchmark regression check failed: one or more trials had non-zero upExitCode.");
    console.error(details);
    process.exit(1);
  }

  const grouped = new Map<string, TrialResult[]>();
  for (const row of results.results) {
    const key = groupKey(row.n, row.mode, row.variant);
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }

  const summaries: ComboSummary[] = [];
  const errors: string[] = [];

  for (const [key, rows] of grouped.entries()) {
    const sample = rows[0];
    if (!sample) continue;

    const nKey = String(sample.n);
    const comboKey = `${sample.mode}/${sample.variant}`;
    const threshold = baseline.thresholds[nKey]?.[comboKey]?.maxUpP50Ms;
    if (threshold === undefined) {
      errors.push(`Missing baseline threshold for n=${nKey}, combo=${comboKey}`);
      continue;
    }

    const limit = threshold * (1 + tolerancePct / 100);
    const upValues = getUpValues(rows);
    const p50 = median(upValues);
    const pass = p50 !== null && p50 <= limit;

    summaries.push({
      n: sample.n,
      mode: sample.mode,
      variant: sample.variant,
      p50,
      threshold,
      limit,
      pass,
    });

    if (!pass) {
      if (p50 === null) {
        errors.push(`No successful upMs values for n=${sample.n}, combo=${comboKey}`);
      } else {
        errors.push(
          `${sample.mode}/${sample.variant} n=${sample.n} p50=${formatMs(p50)} exceeds limit=${formatMs(limit)} (threshold=${formatMs(threshold)}, tolerance=${tolerancePct}%)`,
        );
      }
    }
  }

  summaries.sort((a, b) => {
    if (a.n !== b.n) return a.n - b.n;
    if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
    return a.variant.localeCompare(b.variant);
  });

  const header = "| N | Mode | Variant | p50 up | threshold | status |";
  const divider = "| --- | --- | --- | --- | --- | --- |";
  const lines = summaries.map((summary) => {
    const p50Text = summary.p50 === null ? "N/A" : formatMs(summary.p50);
    const thresholdText = `${formatMs(summary.threshold)} (limit ${formatMs(summary.limit)})`;
    const status = summary.pass ? "PASS" : "FAIL";
    return `| ${summary.n} | ${summary.mode} | ${summary.variant} | ${p50Text} | ${thresholdText} | ${status} |`;
  });

  console.log([header, divider, ...lines].join("\n"));

  if (errors.length > 0) {
    console.error("Benchmark regression check failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
