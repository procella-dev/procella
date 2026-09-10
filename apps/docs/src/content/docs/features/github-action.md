---
title: GitHub Actions
description: Run the official Pulumi and ESC GitHub Actions against Procella without wiring up backend URLs.
---

Procella provides repository-hosted actions for Pulumi operations and ESC environment injection. Both use the bare Procella production origin, `https://api.procella.cloud`, by default, so production workflows do not need a `cloud-url` input.

Earlier Procella Pulumi action releases incorrectly included `/api` in that default and in the documentation. The Pulumi CLI appends `/api` itself, so those releases requested `/api/api/...`. This was a Procella action default and documentation defect, not customer misuse.

## Pulumi action

`tektum/procella/actions/pulumi` is a composite action that delegates Pulumi operations to the official [`pulumi/actions`](https://github.com/pulumi/actions) action (pinned to `v7`). It can optionally authenticate to Procella through GitHub Actions OIDC before Pulumi runs.

The wrapper removes a separate `pulumi login` step from your workflow. Pulumi operations (`preview`, `up`, `destroy`, PR comments, step summaries, secrets providers, policy packs) retain the upstream action's behavior.

## Static access key

For an existing access-key workflow, pass `PULUMI_ACCESS_TOKEN` as before:

```yaml
name: Pulumi Preview

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write # only needed for comment-on-pr

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: tektum/procella/actions/pulumi@main
        with:
          command: preview
          stack-name: my-org/my-project/staging
          comment-on-pr: true
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

When `oidc-organization` is omitted, `PULUMI_ACCESS_TOKEN` is required. Procella access keys are long-lived, so store one as a repository or environment secret. Existing static-token workflows need no changes.

`@main` tracks the latest action definition. Pin the Procella action to a commit SHA or release tag for reproducible builds.

`comment-on-pr: true` makes the upstream action post the preview diff to the pull request. That posting is the upstream action's own behavior: it uses `GITHUB_TOKEN` (via the `github-token` input, which defaults to `${{ github.token }}`), so the job needs `pull-requests: write`. Procella never posts PR comments or commit statuses; its GitHub App integration provides tenant connection and GitHub Actions OIDC. The Pulumi CLI still supplies VCS and CI metadata with each update, but Procella stores that metadata without publishing it to GitHub.

To deploy instead of previewing, use `command: up` on `push`. To tear a stack down, use `command: destroy`.

## Secretless OIDC workflow

Set `oidc-organization` to explicitly enable OIDC authentication. The value is the Procella organization slug; the action never infers it from `stack-name`. Grant the job `id-token: write` so GitHub can mint an OIDC token. No `PULUMI_ACCESS_TOKEN` secret is needed.

```yaml
name: Pulumi Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: tektum/procella/actions/pulumi@main
        with:
          command: up
          stack-name: my-org/my-project/production
          oidc-organization: my-org
```

The action first runs `pulumi/auth-actions@v2`, requests an organization access token with type `urn:pulumi:token-type:access_token:organization`, and exports the short-lived token as `PULUMI_ACCESS_TOKEN` for the following `pulumi/actions` step. Configure a matching Procella OIDC trust policy before using the workflow; see [OIDC CI Authentication](/operations/oidc-ci/).

## Pointing at a different backend

Pass `cloud-url` explicitly only to target another Procella deployment. Use its bare origin, without `/api`:

```yaml
      - uses: tektum/procella/actions/pulumi@main
        with:
          command: up
          stack-name: my-org/my-project/production
          oidc-organization: my-org
          cloud-url: https://procella.internal.example.com
```

The same `cloud-url` value is passed to OIDC authentication and the Pulumi action. For the example above, `pulumi/auth-actions` resolves the exchange endpoint to `https://procella.internal.example.com/api/oauth/token`, while the Pulumi CLI appends `/api` for backend requests. Passing `cloud-url: ""` selects Pulumi Cloud rather than retaining an existing backend, so do not combine an empty value with Procella OIDC.

## Supported inputs

The action declares and forwards the complete 37-input surface of `pulumi/actions` at the pinned commit, one-to-one, with upstream's defaults. `cloud-url` is the only upstream default that differs. The Procella-only `oidc-organization` input controls the preceding authentication step and is not forwarded upstream. Consult the [upstream input reference](https://github.com/pulumi/actions#inputs) for the delegated inputs.

Two limitations follow from GitHub's action metadata format:

- **The upstream surface is explicit, not dynamic.** A composite action cannot forward inputs it does not declare. If upstream adds an input, this action must be updated before you can pass it; until then GitHub warns about an unexpected input and the value is dropped. `scripts/pulumi-action.test.ts` pins the upstream surface so a pin bump that is not re-synced fails the test suite.
- **OIDC is explicit.** Only a non-empty `oidc-organization` enables OIDC. The organization is not derived from `stack-name`, and omitting the input leaves static `PULUMI_ACCESS_TOKEN` handling unchanged.

The single output, `output` (stdout of the Pulumi command), is re-exported.

## ESC action

`tektum/procella/actions/esc` mirrors the official [`pulumi/esc-action`](https://github.com/pulumi/esc-action) `v3.2.1` runtime and changes only its identity and `cloud-url` default. Environment injection, secret masking, and per-key step outputs remain the official action's behavior.

With an access key, omit `cloud-url` and pass the token as usual:

```yaml
      - name: Inject Procella ESC environment
        id: esc
        uses: tektum/procella/actions/esc@main
        with:
          environment: my-org/my-project/ci
          export-environment-variables: AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}

      - run: ./deploy.sh
        env:
          CONFIG_VALUE: ${{ steps.esc.outputs.CONFIG_VALUE }}
```

For secretless authentication, grant `id-token: write` and use the upstream ESC OIDC inputs:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - name: Inject Procella ESC environment
        uses: tektum/procella/actions/esc@main
        with:
          environment: my-org/my-project/ci
          oidc-auth: true
          oidc-organization: my-org
          oidc-requested-token-type: urn:pulumi:token-type:access_token:organization

      - run: ./deploy.sh
```

Configure a matching Procella trust policy first. The OIDC token is used only inside the action and is not exported to later steps. For a non-production or self-hosted Procella deployment, set `cloud-url` to its bare origin, such as `https://procella.internal.example.com`.

The action exposes the complete input contract of the pinned official release: `version`, `environment`, deprecated `keys`, `cloud-url`, `export-environment-variables`, `oidc-auth`, `oidc-organization`, `oidc-requested-token-type`, `oidc-scope`, and `oidc-token-expiration`. Consult the [official ESC action reference](https://github.com/pulumi/esc-action#inputs) for details. Pin the Procella action to a release tag or full commit SHA in production workflows instead of tracking `@main`.
