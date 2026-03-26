export type Mode = "checkpoint" | "journal";
export type Variant = "plain" | "secrets";

export interface TrialResult {
  n: number;
  mode: Mode;
  variant: Variant;
  trial: number;
  upMs: number | null;
  previewMs: number | null;
  destroyMs: number | null;
  checkpointBytes: number | null;
  journalEntryCount: number | null;
  upExitCode: number;
  previewExitCode: number | null;
  destroyExitCode: number | null;
  upStderr: string;
  previewStderr: string;
  destroyStderr: string;
}

export interface BenchmarkResults {
  runAt: string;
  benchSizes: number[];
  trialsPerSize: number;
  results: TrialResult[];
}

export interface BaselineThreshold {
  maxUpP50Ms: number;
}

export interface BaselineConfig {
  description: string;
  tolerancePct: number;
  thresholds: Record<string, Record<string, BaselineThreshold>>;
}
