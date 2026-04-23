# esc-eval — Procella ESC evaluator Lambda

Embeds [`github.com/pulumi/esc`](https://github.com/pulumi/esc) (Apache-2.0, v0.23.0) as a Go library to evaluate ESC YAML environments. Part of the `procella-yj7` epic (Pulumi ESC equivalent).

The handler (`cmd/lambda/main.go` + `loaders.go`) invokes `eval.LoadYAMLBytes` + `eval.EvalEnvironment` with a `payloadEnvironmentLoader` (reads imports from the invoke payload, never touches DB/network) and a `stubProviderLoader` (real `fn::open::*` providers land in procella-yj7.17-21).

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

SST infra lives in `infra/esc.ts`. The `ProcellaCliApi` function links this Lambda and exposes the name as `PROCELLA_ESC_EVALUATOR_FN_NAME` — the TS `LambdaEvaluatorClient` reads that and invokes via `@aws-sdk/client-lambda`.

## Status

| Task | Status |
|---|---|
| procella-yj7.1 — validate Go library import | ✅ done |
| procella-yj7.3 — scaffold Go module + Lambda skeleton | ✅ done |
| procella-yj7.11 — real handler with `eval.EvalEnvironment` | ✅ done |
| procella-yj7.12 — SST infra (`infra/esc.ts`) | ✅ done |
| procella-yj7.13 — `LambdaEvaluatorClient` TS → Lambda invoke | ✅ done |
| procella-yj7.15 — CI Go build step | open |
| procella-yj7.14 — wire `open`/`session` endpoint through evaluator | open |
