# esc-eval — Procella ESC evaluator Lambda

Embeds [`github.com/pulumi/esc`](https://github.com/pulumi/esc) (Apache-2.0, v0.23.0) as a Go library to evaluate ESC YAML environments. Part of the `procella-yj7` epic (Pulumi ESC equivalent).

The handler (`cmd/lambda/main.go` + `loaders.go`) invokes `eval.LoadYAMLBytes` + `eval.EvalEnvironment` with a `payloadEnvironmentLoader` (reads imports from the invoke payload, never touches DB/network) and `providers.NewRegistry()` for supported `fn::open::*` providers (`aws-login`, `aws-secrets`, `aws-parameter-store`, `vault-secrets`). `stubProviderLoader` remains in `loaders.go` for tests that want an explicit unknown-provider loader.

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

## Dynamic providers

Supported provider names:

- `fn::open::aws-login` — returns short-lived AWS credentials from either static inputs or `AssumeRoleWithWebIdentity`
- `fn::open::aws-secrets` — reads one AWS Secrets Manager secret
- `fn::open::aws-parameter-store` — reads one SSM Parameter Store value
- `fn::open::vault-secrets` — reads one Vault KV v2 secret and spreads `data.data`

### Cross-account AWS trust policy

`aws-login` reads the JWT from `AWS_WEB_IDENTITY_TOKEN_FILE` and calls STS `AssumeRoleWithWebIdentity`. Customer-owned target roles need a trust policy that allows that OIDC issuer + subject to assume the role, for example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<target-account-id>:oidc-provider/<issuer-host>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "<issuer-host>:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Procella grants the evaluator Lambda `sts:AssumeRoleWithWebIdentity`, `secretsmanager:GetSecretValue`, and `ssm:GetParameter`; customers still control which cross-account roles trust the presented web identity.

### Vault from a VPC-attached Lambda

`infra/esc.ts` attaches the evaluator to the shared VPC. The non-production shared VPC is imported from the production stage, and production creates it with NAT enabled. If your Vault endpoint is public, ensure the subnets used by the Lambda have outbound internet/NAT access; if Vault is private, ensure routing/security groups allow HTTPS egress to the Vault address.

## Status

| Task | Status |
|---|---|
| procella-yj7.1 — validate Go library import | ✅ done |
| procella-yj7.3 — scaffold Go module + Lambda skeleton | ✅ done |
| procella-yj7.11 — real handler with `eval.EvalEnvironment` | ✅ done |
| procella-yj7.12 — SST infra (`infra/esc.ts`) | ✅ done |
| procella-yj7.13 — `LambdaEvaluatorClient` TS → Lambda invoke | ✅ done |
| procella-yj7.14 — wire `open`/`session` endpoint through evaluator | ✅ done |
| procella-yj7.15 — CI Go build step | ✅ done |
