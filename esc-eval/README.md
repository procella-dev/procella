# esc-eval — Procella ESC evaluator Lambda

Will embed [`github.com/pulumi/esc`](https://github.com/pulumi/esc) (Apache-2.0) as a Go library to evaluate ESC YAML environments, once the handler is implemented in procella-yj7.11. Part of the `procella-yj7` epic (Pulumi ESC equivalent).

This scaffold only pins the dependency in `go.mod` via a blank import; the real `eval.EvalEnvironment` wiring lands in procella-yj7.11.

## Architecture decision

**Path A** — direct library import — chosen per the procella-yj7.34 decision after a local spike confirmed public importability. See the epic `procella-yj7` for the full decision matrix (Paths A/B1/B2/B3).

## Invocation contract

The TS side (`packages/esc/src/evaluator-client.ts`) resolves the entire import graph from PostgreSQL before invoking. The Lambda payload:

```json
{
  "definition": "<YAML body of target environment>",
  "imports":    { "project/env": "<YAML body>" },
  "encryptionKeyHex": "<64 hex chars>"
}
```

The Lambda never reads from the DB or the network for imports — all inputs are in the payload.

## Build

```bash
make build    # writes ../.build/esc-eval/bootstrap (linux amd64)
make tidy
make test
```

SST infra will live in `infra/esc.ts` (procella-yj7.12 — not yet implemented) and will point at `.build/esc-eval` with `handler: bootstrap`, `runtime: provided.al2023`, matching the existing `api`/`gc`/`migrate` Lambda pattern.

## Status

| Task | Status |
|---|---|
| procella-yj7.1 — validate Go library import | ✅ done |
| procella-yj7.3 — scaffold Go module + Lambda skeleton | 🟡 in progress (this PR) |
| procella-yj7.11 — implement handler with `eval.EvalEnvironment` | open |
| procella-yj7.12 — SST infra (`infra/esc.ts`) | open |
| procella-yj7.15 — CI Go build step | open |
