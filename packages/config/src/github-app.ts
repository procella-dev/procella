import { createPrivateKey } from "node:crypto";

/**
 * Stable Descope Outbound Application ID that vaults each admin's GitHub user
 * token. Provisioned by scripts/provision-descope-outbound-app.ts and shared
 * with the runtime so no stage-specific identifier is ever hardcoded.
 */
export const GITHUB_OUTBOUND_APP_ID = "procella-github";
export const DESCOPE_OUTBOUND_CALLBACK_URL = "https://api.descope.com/v1/outbound/oauth/callback";
export const GITHUB_OUTBOUND_APP_ID_ERROR = "Must be a lowercase slug of 1-64 characters";

export function isValidGitHubOutboundAppId(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

export const GITHUB_APP_ID_ERROR = "Must be a positive safe integer in canonical decimal form";
export const GITHUB_APP_PRIVATE_KEY_ERROR = "Must be a valid RSA private key";
export const GITHUB_APP_WEBHOOK_SECRET_ERROR = "Must contain non-whitespace characters";

export function isValidGitHubAppId(value: string): boolean {
	return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

export function parseGitHubAppPrivateKey(value: string): string {
	const normalized = value.replace(/\\n/g, "\n");
	if (normalized.trim().length === 0) {
		throw new Error(GITHUB_APP_PRIVATE_KEY_ERROR);
	}

	try {
		const key = createPrivateKey(normalized);
		if (key.asymmetricKeyType !== "rsa") {
			throw new Error(GITHUB_APP_PRIVATE_KEY_ERROR);
		}
	} catch {
		throw new Error(GITHUB_APP_PRIVATE_KEY_ERROR);
	}

	return normalized;
}

export function isValidGitHubAppWebhookSecret(value: string): boolean {
	return value.trim().length > 0;
}
