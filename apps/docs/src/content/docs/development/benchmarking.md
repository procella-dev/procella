---
title: Benchmarking
description: Performance benchmarks for Pulumi update operations with and without journaling.
---

Procella includes a benchmark suite that measures Pulumi update performance across varying stack sizes. It compares the traditional checkpoint path against the journaling protocol.

## Running Benchmarks

```bash
bun run bench
```

This starts a Procella server on port 18081, runs all benchmarks, and prints a Markdown results table.

### Quick Smoke Test

```bash
BENCH_SIZES=10 BENCH_TRIALS=1 bun run bench
```

### Full Run

```bash
BENCH_SIZES=10,50,100,500,1000 BENCH_TRIALS=5 bun run bench
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BENCH_SIZES` | `10,50,100,500` | Comma-separated resource counts to test |
| `BENCH_TRIALS` | `3` | Number of trials per (size, mode) combination |
| `BENCH_URL` | — | Target a live Procella server instead of starting one locally |
| `BENCH_TOKEN` | `benchtoken` | API token when targeting a remote server |
| `BENCH_DATABASE_URL` | Same as `PROCELLA_DATABASE_URL` | Database URL for collecting storage metrics |

## Modes

### Local Mode (default)

When no `BENCH_URL` is set, the benchmark:

1. Starts a Procella server on port 18081
2. Runs the `checkpoint` mode (traditional full-snapshot path)
3. Stops the server
4. Starts a new server with `PROCELLA_ENABLE_JOURNALING=true`
5. Runs the `journal` mode (per-resource journal entries)
6. Stops the server

Between each trial, all database tables are truncated for a clean baseline.

### Remote Mode

When `BENCH_URL` is set, the benchmark runs against an existing server:

```bash
BENCH_URL=https://procella.example.com BENCH_TOKEN=pul-xxx bun run bench
```

In remote mode:
- No server is started or stopped
- Only one mode runs (whichever the server is configured for)
- Each trial uses a unique stack name to avoid conflicts
- Stacks are cleaned up via `pulumi stack rm` after each trial
- DB metrics are only available if `BENCH_DATABASE_URL` is also set

## What It Measures

For each combination of resource count, mode, and trial:

| Metric | Description |
|---|---|
| `up` | Wall-clock time for `pulumi up --yes` |
| `preview` | Wall-clock time for `pulumi preview` after up |
| `destroy` | Wall-clock time for `pulumi destroy --yes` |
| `checkpoint bytes` | Size of the latest checkpoint stored in PostgreSQL |
| `journal entries` | Number of journal entries written during the update |

## Output

Results are printed as Markdown tables to stdout and written to `bench/results.json`.

The timing table shows p50 (median), min, and max across trials:

```
| N   | Mode       | up p50   | up min   | up max   | preview p50 | destroy p50 | Status |
| --- | ---        | ---      | ---      | ---      | ---         | ---         | ---    |
| 10  | checkpoint | 2341.0ms | 2100.0ms | 2510.0ms | 1200.0ms    | 800.0ms     | OK     |
| 50  | checkpoint | 5200.0ms | 4800.0ms | 5600.0ms | 2100.0ms    | 1500.0ms    | OK     |
```

The storage table shows averages:

```
| N   | Mode       | Checkpoint Bytes | Journal Entries |
| --- | ---        | ---              | ---             |
| 10  | checkpoint | 4096             | 0.0             |
| 10  | journal    | 2048             | 10.0            |
```

## How Journaling Works

Journaling is enabled by default. When the CLI sends `journalVersion: 1` in the `StartUpdate` request, the server echoes it back and the CLI sends per-resource journal entries instead of full checkpoints.

The benchmark's `checkpoint` mode forces the CLI to use the traditional path by setting `PULUMI_DISABLE_JOURNALING=true`. The `journal` mode lets the CLI use journaling naturally.

For more on the journaling protocol, see [Pulumi's journaling blog post](https://www.pulumi.com/blog/journaling/).
