---
title: GitHub App
description: PR preview comments and commit status checks for Pulumi stacks.
---

The Procella GitHub App integration posts preview results directly to pull requests. When a CI run executes `pulumi preview` against a stack tagged with GitHub metadata, Procella automatically:

- Posts a comment on the PR with the preview diff (resources to add, change, or delete)
- Sets a commit status check (`pulumi/preview`) that shows pass/fail in the PR checks UI

This gives reviewers infrastructure change context without leaving GitHub.

## Setup

### 1. Create a GitHub App

Go to **GitHub** > **Settings** > **Developer settings** > **GitHub Apps** > **New GitHub App**.

Fill in:

| Field | Value |
|---|---|
| GitHub App name | `procella-your-org` (must be globally unique) |
| Homepage URL | Your Procella instance URL |
| Webhook URL | `https://your-procella.example.com/api/webhooks/github` |
| Callback URL | `https://api.descope.com/v1/outbound/oauth/callback` |
| Setup URL | `https://your-procella.example.com/github/setup` |
| Redirect on update | Disabled |
| Webhook secret | A random string you generate (save it, you'll need it) |

The callback URL points at Descope, not Procella: a Descope Outbound Application
performs the GitHub user authorization and vaults the resulting user token, so
the raw GitHub token never reaches Procella's database, logs, or the browser.

Under **Repository permissions**, set:

| Permission | Access |
|---|---|
| Pull requests | Read & write |
| Commit statuses | Read & write |
| Contents | Read-only |
| Metadata | Read-only |

Under **Organization permissions**, set **Members** to **Read-only**. Procella uses this only
during setup to verify that the authorizing GitHub user is an active organization administrator.

Under **Subscribe to events**, check:

- Pull request
- Push

Click **Create GitHub App**. On the next page, note your **App ID** and **Client ID**, then
generate and save a **Client secret**. The client ID and secret are used only to provision the
Descope outbound application at deploy time.

Scroll down to **Private keys** and click **Generate a private key**. This downloads a `.pem` file.

### 2. Configure Environment Variables

The integration is optional. Omit all three variables to start Procella with GitHub integration disabled. To enable it, configure all three; empty, partial, and invalid values are rejected.

| Variable | Description |
|---|---|
| `PROCELLA_GITHUB_APP_ID` | The positive numeric App ID from GitHub, without signs, whitespace, decimals, exponents, or leading zeros |
| `PROCELLA_GITHUB_APP_PRIVATE_KEY` | A valid RSA private key PEM from GitHub (raw multiline or `\n`-escaped) |
| `PROCELLA_GITHUB_APP_WEBHOOK_SECRET` | The non-whitespace webhook secret you set in step 1; surrounding bytes are significant and preserved |

Tenant setup additionally needs Descope credentials and the dashboard origin:

| Variable | Description |
|---|---|
| `PROCELLA_DESCOPE_PROJECT_ID` | Descope project that owns the outbound application |
| `PROCELLA_DESCOPE_MANAGEMENT_KEY` | Management key used to fetch and delete vaulted GitHub user tokens |
| `PROCELLA_GITHUB_OUTBOUND_APP_ID` | Outbound application ID; defaults to `procella-github` |
| `PROCELLA_APP_ORIGIN` | Absolute dashboard origin (`https://app.example.com`) the outbound callback returns to |

The GitHub OAuth **client ID and client secret are deploy-time only**. They configure the Descope
outbound application and are never placed in a server environment; `bun run lint:deploy-manifests`
fails if `PROCELLA_GITHUB_APP_CLIENT_ID` or `PROCELLA_GITHUB_APP_CLIENT_SECRET` appears in a runtime
manifest.

For Docker or docker-compose, pass these as environment variables:

```bash
PROCELLA_GITHUB_APP_ID=123456
PROCELLA_GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAK...
-----END RSA PRIVATE KEY-----"
PROCELLA_GITHUB_APP_WEBHOOK_SECRET=my-random-secret
PROCELLA_APP_ORIGIN=https://app.example.com
```

For Vercel or similar platforms, use the environment variable UI. The private key value should be the raw multiline PEM string.

### 3. Provision the Descope Outbound Application

SST provisions the outbound application on every deploy through the checked-in idempotent script:

```bash
PROCELLA_DESCOPE_PROJECT_ID=P2... \
PROCELLA_DESCOPE_MANAGEMENT_KEY=... \
PROCELLA_GITHUB_APP_CLIENT_ID=Iv1.example \
PROCELLA_GITHUB_APP_CLIENT_SECRET=github-app-client-secret \
bun run scripts/provision-descope-outbound-app.ts
```

It creates or updates the `procella-github` outbound application with GitHub's authorization
(`https://github.com/login/oauth/authorize`) and token (`https://github.com/login/oauth/access_token`)
URLs, the Descope callback URL, PKCE disabled, and the least-privilege scopes `read:user` and
`read:org` needed to read the connected user and verify active organization administration. The
script hash is a Pulumi trigger, so changing it reprovisions on the next deploy.

### 4. Connect the App to a Tenant

Sign in to Procella as a tenant administrator, open **Settings** > **GitHub**, enter the exact GitHub user or organization login to connect, and select **Install & Verify GitHub App**.

1. Procella mints a one-time connect transaction bound to the tenant, the initiating administrator,
   the requested account, and a fresh `__Host-` browser nonce, then asks Descope, server-side and
   using the browser's own session, for the GitHub authorization URL. The signed transaction travels
   inside the Descope redirect URL, and the returned URL must be GitHub's authorization endpoint.
   Session and refresh tokens stay HttpOnly; the browser only ever receives the provider URL.
2. Descope completes the code exchange and vaults the GitHub user token **for that tenant**, then
   returns the browser to `/settings/github/connected?state=...`.
3. Procella consumes the transaction exactly once, requiring the browser nonce cookie and the same
   tenant and administrator that opened it, reads the tenant-scoped vaulted token, confirms the
   connected GitHub identity, and only then issues browser-bound installation state and sends the
   browser to GitHub. A forwarded authorization link is therefore useless: the callback cannot be
   continued from another browser, tenant, or user, and a used or expired transaction is rejected.
4. GitHub's setup callback re-verifies the signed state, the browser binding, the App-authenticated
   installation identity, and the vaulted GitHub identity, requiring proof that the user owns the
   personal account or is an **active administrator** of the organization and that the installation
   is visible to that user, before saving the tenant binding.

Organization membership is unreadable to a GitHub App user token until the App is installed on that
organization, so administration is proven at the callback rather than before installation. No tenant
binding is ever saved without it.

The requested login is untrusted until GitHub confirms that authority. Procella never stores the
GitHub user token; it lives only in the Descope vault, scoped to one tenant, and is read for the
duration of a verification call. The same Descope user connecting from two tenants holds two
independent tokens, and disconnecting one tenant deletes only that tenant's token.

GitHub reports `setup_action=update` when the App is already installed on the account. Procella
accepts that callback under the same signed-state, browser-binding, and vaulted-identity checks, so
an interrupted setup or a pre-existing installation can be bound without uninstalling the App on
GitHub.

Webhook events can update or remove an existing binding, but cannot create one.

Existing installations created before tenant-bound setup are removed during migration because their tenant ownership was inferred from a GitHub account name. Reconnect them from **Settings** > **GitHub**.

### Moving a Repository Between Organizations

Use a GitHub App owned by the destination organization when the previous organization-owned App cannot move with the repository. Create the replacement App under the destination organization, connect it from Procella Settings, and replace all three `PROCELLA_GITHUB_APP_*` runtime credential values together, plus the deploy-time OAuth client credentials used by the outbound provisioner. Procella rejects partial GitHub App configuration.

The new App may keep the existing webhook URL. Confirm a signed delivery succeeds after installation before retiring the old App.

### Deployment Credentials

The deployed Procella instance needs its own dedicated GitHub App credentials. Procella loads the current public App slug from GitHub using those credentials when an administrator starts installation, so App renames do not require configuration changes. Do not supply the Renovate App ID or private key as `PROCELLA_GITHUB_APP_*`; the two apps have different permissions and purposes.

For a direct SST deployment, export `PROCELLA_GITHUB_APP_ENABLED=true` and set `ProcellaGitHubAppId`, `ProcellaGitHubAppClientId`, `ProcellaGitHubAppClientSecret`, `ProcellaGitHubAppPrivateKey`, and `ProcellaGitHubAppWebhookSecret` for that stage (or as SST fallbacks). SST links only the App ID, private key, and webhook secret into the Lambdas; the client ID and secret are passed to the outbound-app provisioning command alone. The GitHub Actions deployment workflows source the opt-in from the non-secret environment variable of the same name and the credentials from the matching `PROCELLA_GITHUB_APP_*` environment secrets. When the variable is unset or `false`, SST does not link the integration, even if a preview stage retains values from an older deployment. This cleanly removes obsolete secret resources on the next deploy. A partial group or invalid credential fails deployment when the integration is enabled.

With the integration disabled, preview and production deployments remain healthy but GitHub setup, webhooks, PR comments, and commit statuses are unavailable. Without Descope management credentials the App still serves webhooks, PR comments, and commit statuses, but tenant setup fails closed. Live PR-comment end-to-end testing requires a dedicated Procella GitHub App installed on the test repository, all five credentials in the preview environment, and `PROCELLA_GITHUB_APP_ENABLED=true`. It cannot use the Renovate App.

## How PR Comments Work

During an update, the Pulumi CLI sends source-control and CI metadata to Procella. For GitHub pull-request runs, Procella snapshots these values when the update is created:

| Update metadata | Purpose |
|---|---|
| `vcs.owner` | GitHub organization or user |
| `vcs.repo` | Repository name |
| `ci.pr.number` | Pull request number |
| `ci.pr.headSHA` | Pull request head commit |

If `ci.pr.headSHA` is unavailable, Procella falls back to `git.head`. The metadata repository must match the stack's persisted `vcs:owner` and `vcs:repo` identity. Workload callers must also be bound to that repository. `github:*` stack tags are ignored and cannot authorize a publication.

Starting a matching update transactionally enqueues a pending commit status and PR comment. Completion or cancellation enqueues the final edit in the same database transaction as the status change. Procella stores the highest-sequence Pulumi summary event and revises the final comment if a newer summary arrives late. If no summary arrived, the comment says `summary unavailable`.

Delivery uses a PostgreSQL outbox. Workers resolve the repository's current tenant-bound GitHub App installation, recover an existing comment by its hidden update marker after a crash, and edit that same comment. Leased claims, ordered phases, idempotent revisions, and bounded retry backoff make delivery safe across replicas and Lambda invocations.

## CI/CD Integration

Use the [Procella GitHub Action](/features/github-action/) to run a preview against the hosted Procella backend. The Pulumi CLI supplies the GitHub metadata automatically, so no `pulumi stack tag set` commands are required.

```yaml
name: Pulumi Preview

on:
  pull_request:
    branches: [main]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: tektum/procella/actions/pulumi@e036a1df5937e4ffc351c2fc47b5ea743b7f782e
        with:
          command: preview
          stack-name: my-org/my-project/staging
        env:
          PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
```

The metadata is attached to each update rather than stored on the stack, so concurrent or subsequent pull-request runs do not reuse another run's PR number or commit SHA.

## Managing the Integration

Go to **Settings** in the dashboard and open the **GitHub** tab. From here you can:

- Connect the configured GitHub App to the current tenant
- See every GitHub account installation bound to the tenant
- Reopen GitHub to configure repository access
- Disconnect a tenant binding, which also deletes your vaulted GitHub authorization, without uninstalling the GitHub App

## Roadmap

The following features are planned for a later phase:

- **Git push to deploy** — automatically run `pulumi up` on merge to a configured branch
- **Review stacks** — ephemeral stacks created per PR and destroyed on merge/close, using stack tags to link them to the PR lifecycle

These aren't available yet. Track their status in the project's issue tracker.
