import {
	GITHUB_APP_ID_ERROR,
	GITHUB_APP_PRIVATE_KEY_ERROR,
	GITHUB_APP_WEBHOOK_SECRET_ERROR,
	isValidGitHubAppId,
	isValidGitHubAppWebhookSecret,
	parseGitHubAppPrivateKey,
} from "@procella/config";

const secretNames = {
	appId: "ProcellaGitHubAppId",
	clientId: "ProcellaGitHubAppClientId",
	clientSecret: "ProcellaGitHubAppClientSecret",
	privateKey: "ProcellaGitHubAppPrivateKey",
	webhookSecret: "ProcellaGitHubAppWebhookSecret",
} as const;

const secretEnvironmentKeys = {
	appId: `SST_SECRET_${secretNames.appId}`,
	clientId: `SST_SECRET_${secretNames.clientId}`,
	clientSecret: `SST_SECRET_${secretNames.clientSecret}`,
	privateKey: `SST_SECRET_${secretNames.privateKey}`,
	webhookSecret: `SST_SECRET_${secretNames.webhookSecret}`,
} as const;

const enabledEnvironmentKey = "PROCELLA_GITHUB_APP_ENABLED";

type Environment = Record<string, string | undefined>;

export function resolveGitHubAppSecretNames(environment: Environment) {
	const values = {
		appId: environment[secretEnvironmentKeys.appId],
		clientId: environment[secretEnvironmentKeys.clientId],
		clientSecret: environment[secretEnvironmentKeys.clientSecret],
		privateKey: environment[secretEnvironmentKeys.privateKey],
		webhookSecret: environment[secretEnvironmentKeys.webhookSecret],
	};
	const enabled = environment[enabledEnvironmentKey];
	if (enabled === undefined || enabled === "" || enabled === "false") {
		return null;
	}
	if (enabled !== "true") {
		throw new Error("PROCELLA_GITHUB_APP_ENABLED must be true, false, or unset.");
	}

	if (
		!values.appId &&
		!values.clientId &&
		!values.clientSecret &&
		!values.privateKey &&
		!values.webhookSecret
	) {
		throw new Error(
			"GitHub App integration requires the ProcellaGitHubAppId, ProcellaGitHubAppClientId, ProcellaGitHubAppClientSecret, ProcellaGitHubAppPrivateKey, and ProcellaGitHubAppWebhookSecret SST secrets together.",
		);
	}
	if (
		!values.appId ||
		!values.clientId ||
		!values.clientSecret ||
		!values.privateKey ||
		!values.webhookSecret
	) {
		throw new Error(
			"GitHub App integration requires the ProcellaGitHubAppId, ProcellaGitHubAppClientId, ProcellaGitHubAppClientSecret, ProcellaGitHubAppPrivateKey, and ProcellaGitHubAppWebhookSecret SST secrets together.",
		);
	}
	if (!isValidGitHubAppId(values.appId)) {
		throw new Error(`ProcellaGitHubAppId: ${GITHUB_APP_ID_ERROR}`);
	}
	try {
		parseGitHubAppPrivateKey(values.privateKey);
	} catch {
		throw new Error(`ProcellaGitHubAppPrivateKey: ${GITHUB_APP_PRIVATE_KEY_ERROR}`);
	}
	if (!isValidGitHubAppWebhookSecret(values.webhookSecret)) {
		throw new Error(`ProcellaGitHubAppWebhookSecret: ${GITHUB_APP_WEBHOOK_SECRET_ERROR}`);
	}

	return secretNames;
}
