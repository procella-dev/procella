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

Sign in to Procella as a tenant administrator, open **Settings** > **GitHub**, and select
**Continue with GitHub**. No account is typed: the administrator authorizes once, then chooses from
the accounts that authorization actually administers.

1. Procella's server mints a one-time connect transaction bound to the tenant, the initiating
   administrator, and a fresh `__Host-` browser nonce, sets the browser nonce as an HttpOnly
   cookie, and returns only the outbound app id, the tenant, and a redirect URL it builds from its
   own configured dashboard origin — never a token. The signed transaction travels inside that
   redirect URL. The browser's own cookie-authenticated Descope SDK then calls the outbound connect
   endpoint directly and only follows a returned URL that is exactly GitHub's authorization
   endpoint. Session and refresh tokens stay HttpOnly and are never read by the dashboard; the
   browser never receives or stores anything else.
2. Descope completes the code exchange and vaults the GitHub user token **for that tenant**, then
   returns the browser to `/settings/github/connected?state=...`.
3. Procella consumes the transaction exactly once, requiring the browser nonce cookie and the same
   tenant and administrator that opened it, and records the vaulted token's Descope token id in
   `github_outbound_connections` in the same transaction. No account is chosen or verified yet.
4. **Settings** > **GitHub** now lists the accounts the confirmed identity administers — its own
   login and every organization GitHub reports it as an active admin of — together with any App
   installation Procella can already see for that account. Each row offers **Connect** or
   **Install**:
   - **Connect** appears when GitHub already reports an installation for the account. Procella
     derives the account entirely from that App-authenticated installation, never from anything the
     browser sends, and binds it through an authenticated first-party mutation with no browser
     redirect to GitHub at all. Binding requires the confirmed identity to be an **active
     administrator** of the account and the installation to be visible to it, checked with **no
     invisible-membership allowance**: the App is already installed, so GitHub always reports real
     membership, and a membership lookup GitHub cannot answer is a denial rather than something to
     defer.
   - **Install** appears when no installation exists yet for the account. Procella verifies
     administration first — a GitHub App user token cannot see organization membership before the
     App is installed there, so this leg does tolerate a membership lookup GitHub cannot answer —
     then sends the browser to GitHub's install URL. This is the only path that still traverses the
     App-level Setup URL from step 1. GitHub's setup callback there re-verifies the signed state,
     the browser binding, the App-authenticated installation identity, and the confirmed GitHub
     identity before saving the tenant binding.

   **The list cannot show an organization the App has never been installed on.** A GitHub App user
   access token reaches only resources that both the user and the App can reach, so organization
   memberships are filtered to accounts the App is already installed on. For everything else, use
   **Choose an account on GitHub**: Procella issues installation state that names no account,
   GitHub's own installation picker chooses the target, and the setup callback derives the installed
   account and requires active administration of it with no invisible-membership allowance before
   binding. That is the route for a first-time organization install.

No tenant binding is ever saved without both an active-administration proof and an
installation-visibility proof, freshly checked for whichever path bound it: **Connect** proves them
synchronously in the mutation; **Install** proves them again at the GitHub callback, since the
installation itself only exists once that callback runs.

**A vaulted token is unusable until it is confirmed.** Descope vaults a token the moment GitHub
authorizes, so forwarding a connect URL to someone else can create one; every consumer therefore
requires the current tenant-scoped token's id to equal the confirmed id in PostgreSQL. Before
confirmation the connection reads as disconnected and administration and installation checks
reject, and a token that later replaces the confirmed one invalidates the confirmation.

Procella never stores the GitHub user token; it lives only in the Descope vault, scoped to one
tenant, and is read for the duration of a verification call. The same Descope user connecting from
two tenants holds two independent confirmed tokens, and disconnecting one tenant deletes only that
tenant's token.

GitHub reports `setup_action=update` when the App is already installed on the account. Procella
accepts that callback under the same signed-state, browser-binding, and vaulted-identity checks, so
an interrupted setup or a pre-existing installation can still be bound through the **Install** path
without uninstalling the App on GitHub.

Webhook events can update or remove an existing binding, but cannot create one.

An App installed directly from GitHub — outside Procella entirely — is not a special case: once its
administrator connects, it appears in the same account list with **Connect** in place of
**Install**, so it can be adopted without reinstalling.

Existing installations created before tenant-bound setup are removed during migration because their tenant ownership was inferred from a GitHub account name. Reconnect them from **Settings** > **GitHub**.

### 5. Enable GitHub Actions OIDC

After the installation is connected, select **Enable Actions OIDC** on its card, choose the
repository that runs Pulumi, and select **Enable OIDC**. Procella asks GitHub for the repositories
visible to that exact installation and creates a repository-scoped trust policy from GitHub's
stable numeric owner and repository IDs. The browser never supplies those trust claims.

This grants matching workflows Procella's `member` role for up to two hours. The GitHub workflow
still needs `permissions: id-token: write` and the Procella action's `oidc-organization` input. See
[OIDC CI Authentication](../operations/oidc-ci/) for the workflow example and advanced claim
restrictions.

### Moving a Repository Between Organizations

Use a GitHub App owned by the destination organization when the previous organization-owned App cannot move with the repository. Create the replacement App under the destination organization, connect it from Procella Settings, and replace all three `PROCELLA_GITHUB_APP_*` runtime credential values together, plus the deploy-time OAuth client credentials used by the outbound provisioner. Procella rejects partial GitHub App configuration.

The new App may keep the existing webhook URL. Confirm a signed delivery succeeds after installation before retiring the old App.

### Deployment Credentials

The deployed Procella instance needs its own dedicated GitHub App credentials. Procella loads the current public App slug from GitHub using those credentials when an administrator starts installation, so App renames do not require configuration changes. Do not supply the Renovate App ID or private key as `PROCELLA_GITHUB_APP_*`; the two apps have different permissions and purposes.

Every stage needs a separate App, not just separate credentials. A GitHub App holds exactly one Webhook URL and one Setup URL (only OAuth callback URLs accept several values), so two stages sharing an App both send their post-install callback and their `installation` events to whichever host that single App points at. Installation then fails silently on every other stage: GitHub reports success, the other stage never receives the callback that binds the installation, and **Settings** > **GitHub** keeps reporting the App as not installed. Register one App per deployed stage with that stage's own `https://api.<stage-domain>/api/webhooks/github` and `https://app.<stage-domain>/github/setup`.

Point each stage's App at that stage's own Descope project. The outbound application id is scoped to the project that owns it, so `procella-github` in one project is a different application, with its own vaulted tokens, from `procella-github` in another. The SST deployment provisions `procella-<stage>` per stage and hands the provisioner that project's id, so stages stay isolated without renaming the application.

Vaulted GitHub user tokens are scoped to the OAuth client that issued them. After pointing a stage at a different App, the next connect re-authorizes against the new client; a token left over from the previous client cannot see the new App's installation, because setup verifies it through `GET /user/installations`.

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
