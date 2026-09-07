import { GITHUB_OUTBOUND_APP_ID } from "@procella/config";
import type { Input } from "@pulumi/pulumi";
import { resolveGitHubAppSecretNames } from "./github-app-secrets";

export const encryptionKey = new sst.Secret("ProcellaEncryptionKey");
export const devAuthToken = new sst.Secret("ProcellaDevAuthToken");
export const descopeManagementKey = new sst.Secret("ProcellaDescopeManagementKey");
// GitHub App credentials are optional and validated as an atomic group.
// Workflow opt-in is authoritative so stale SST stage/fallback values cannot
// silently re-enable the integration after its deployment secrets are removed.
const githubAppSecretNames = resolveGitHubAppSecretNames(process.env);
export const githubAppSecrets = githubAppSecretNames
	? {
			appId: new sst.Secret(githubAppSecretNames.runtime.appId),
			privateKey: new sst.Secret(githubAppSecretNames.runtime.privateKey),
			webhookSecret: new sst.Secret(githubAppSecretNames.runtime.webhookSecret),
		}
	: null;

// Deploy-time only: the GitHub OAuth client credentials configure the Descope
// Outbound App that vaults each admin's GitHub user token. They are NEVER
// linked to a Lambda or placed in its environment; the runtime asks Descope
// for tokens instead of exchanging OAuth codes itself.
export const githubAppOAuthSecrets = githubAppSecretNames
	? {
			clientId: new sst.Secret(githubAppSecretNames.provisioning.clientId),
			clientSecret: new sst.Secret(githubAppSecretNames.provisioning.clientSecret),
		}
	: null;

export const githubAppEnvironment: Record<string, Input<string>> = githubAppSecrets
	? {
			PROCELLA_GITHUB_APP_ID: githubAppSecrets.appId.value,
			PROCELLA_GITHUB_APP_PRIVATE_KEY: githubAppSecrets.privateKey.value,
			PROCELLA_GITHUB_APP_WEBHOOK_SECRET: githubAppSecrets.webhookSecret.value,
			PROCELLA_GITHUB_OUTBOUND_APP_ID: GITHUB_OUTBOUND_APP_ID,
		}
	: {};

export const otelEndpoint = new sst.Secret("ProcellaOtelEndpoint");
export const otelHeaders = new sst.Secret("ProcellaOtelHeaders");
export const ticketSigningKey = new sst.Secret("ProcellaTicketSigningKey");

// sharedSecrets are linked into every Lambda. descopeManagementKey and
// ticketSigningKey are NOT included because the GC Lambda never calls Descope
// APIs and never issues/verifies tickets — so granting it those secrets would
// violate least privilege.
// cronSecret is intentionally NOT declared — the AWS deploy uses a dedicated
// gc Lambda (gc-bootstrap.ts) that calls GCWorker.runOnce() directly, so the
// HTTP /cron/gc route in createApp() is never served from this infra. The route
// remains in the codebase for Vercel/Render deploys that drive cron over HTTP.
export const sharedSecrets = [encryptionKey, devAuthToken, otelEndpoint, otelHeaders];

export const apiSecrets = [
	...sharedSecrets,
	descopeManagementKey,
	...(githubAppSecrets ? Object.values(githubAppSecrets) : []),
	ticketSigningKey,
];
