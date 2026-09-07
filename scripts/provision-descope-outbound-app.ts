#!/usr/bin/env bun
// Provisions the Descope Outbound Application that vaults each tenant admin's
// GitHub user token.
//
// Deploy-time only: this is the single place the GitHub App's OAuth client
// secret is used. @descope/pulumi-descope has no outbound-application resource,
// so SST drives this script through command.local.Command and the script keeps
// itself idempotent (load → update, or create on 404).

import DescopeClient, { type OutboundApplication, type SdkResponse } from "@descope/node-sdk";
import { GITHUB_OUTBOUND_APP_ID, isValidGitHubOutboundAppId } from "@procella/config";

export const GITHUB_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** Registered as the GitHub OAuth callback; Descope owns the code exchange. */
export const DESCOPE_OUTBOUND_CALLBACK_URL = "https://api.descope.com/v1/outbound/oauth/callback";
/**
 * Least privilege for the two checks Procella makes: read the connected user
 * (`GET /user`) and its organization membership role (`GET
 * /user/memberships/orgs/{org}`, `GET /user/installations`).
 */
export const GITHUB_OUTBOUND_SCOPES = ["read:user", "read:org"] as const;

type Environment = Readonly<Record<string, string | undefined>>;

type NewOutboundApplication = Omit<OutboundApplication, "id"> &
	Partial<Pick<OutboundApplication, "id">> & { clientSecret?: string };
type ManagedOutboundApplication = OutboundApplication & { clientSecret?: string };

export interface OutboundApplicationSdk {
	createApplication(application: NewOutboundApplication): Promise<SdkResponse<OutboundApplication>>;
	loadApplication(id: string): Promise<SdkResponse<OutboundApplication>>;
	updateApplication(
		application: ManagedOutboundApplication,
	): Promise<SdkResponse<OutboundApplication>>;
}

export interface OutboundProvisionerDependencies {
	readonly environment: Environment;
	readonly createSdk: (projectId: string, managementKey: string) => OutboundApplicationSdk;
	readonly write: (message: string) => void;
}

function requiredEnvironment(environment: Environment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function failedRequest(status: number | undefined): Error {
	return new Error(
		`Descope outbound application request failed with status ${status ?? "unknown"}`,
	);
}

export function createOutboundAppProvisioner({
	environment,
	createSdk,
	write,
}: OutboundProvisionerDependencies): () => Promise<void> {
	return async (): Promise<void> => {
		const appId = environment.PROCELLA_GITHUB_OUTBOUND_APP_ID?.trim() || GITHUB_OUTBOUND_APP_ID;
		if (!isValidGitHubOutboundAppId(appId)) {
			throw new Error("PROCELLA_GITHUB_OUTBOUND_APP_ID must be a lowercase slug");
		}
		const application = {
			id: appId,
			name: "Procella GitHub",
			description:
				"Vaults the GitHub user token Procella uses to verify account administration before binding a GitHub App installation to a tenant.",
			clientId: requiredEnvironment(environment, "PROCELLA_GITHUB_APP_CLIENT_ID"),
			clientSecret: requiredEnvironment(environment, "PROCELLA_GITHUB_APP_CLIENT_SECRET"),
			authorizationUrl: GITHUB_AUTHORIZATION_URL,
			tokenUrl: GITHUB_TOKEN_URL,
			defaultRedirectUrl: DESCOPE_OUTBOUND_CALLBACK_URL,
			defaultScopes: [...GITHUB_OUTBOUND_SCOPES],
			pkce: false,
		};
		const sdk = createSdk(
			requiredEnvironment(environment, "PROCELLA_DESCOPE_PROJECT_ID"),
			requiredEnvironment(environment, "PROCELLA_DESCOPE_MANAGEMENT_KEY"),
		);
		const existing = await sdk.loadApplication(appId);

		if (existing.ok && existing.data) {
			const updated = await sdk.updateApplication({ ...existing.data, ...application });
			if (!updated.ok) {
				throw failedRequest(updated.code);
			}
		} else if (existing.code === 404) {
			const created = await sdk.createApplication(application);
			if (!created.ok) {
				throw failedRequest(created.code);
			}
		} else {
			throw failedRequest(existing.code);
		}

		write(
			`Descope outbound app ${appId} configured. GitHub callback URL: ${DESCOPE_OUTBOUND_CALLBACK_URL}\n`,
		);
	};
}

export const provisionOutboundApp = createOutboundAppProvisioner({
	environment: process.env,
	createSdk: (projectId, managementKey) =>
		DescopeClient({ projectId, managementKey }).management.outboundApplication,
	write: (message) => process.stdout.write(message),
});

if (import.meta.main) {
	provisionOutboundApp().catch((error: unknown) => {
		if (error instanceof Error) {
			console.error(`Descope outbound app provisioning failed: ${error.message}`);
			process.exit(1);
		}
		throw error;
	});
}
