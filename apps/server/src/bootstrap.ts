// @procella/server — Shared bootstrap logic for both Bun.serve and Lambda.
//
// Creates all services and the Hono app. Called once at module load time
// in both entry points (index.ts for local dev, vercel.ts for production).

import { DescopeAuditService, NoopAuditService } from "@procella/audit";
import { createAuthService, DescopeAuthService } from "@procella/auth";
import { loadConfig } from "@procella/config";
import { AesCryptoService, devMasterKey } from "@procella/crypto";
import { createDb } from "@procella/db";
import { PostgresEscService, UnimplementedEvaluatorClient } from "@procella/esc";
import { buildGitHubAppConfig, OctokitGitHubService } from "@procella/github";
import {
	JwksValidatorImpl,
	OidcExchangeService,
	PostgresTrustPolicyRepository,
	type TrustPolicyRepository,
} from "@procella/oidc";
import { PostgresStacksService } from "@procella/stacks";
import { createBlobStorage } from "@procella/storage";
import { initTelemetry } from "@procella/telemetry";
import { PostgresUpdatesService } from "@procella/updates";
import { PostgresWebhooksService } from "@procella/webhooks";
import { createCliApp } from "./routes/cli.js";
import { createApp } from "./routes/index.js";
import { createWebApp } from "./routes/web.js";

async function bootstrapServices() {
	const config = loadConfig();

	initTelemetry({ enabled: config.otelEnabled, serviceName: "procella" });

	const { db, client } = await createDb({ url: config.databaseUrl, max: config.databasePoolMax });

	// Auth
	const authConfig =
		config.authMode === "dev"
			? {
					mode: "dev" as const,
					token: config.devAuthToken as string,
					userLogin: config.devUserLogin,
					orgLogin: config.devOrgLogin,
				}
			: {
					mode: "descope" as const,
					projectId: config.descopeProjectId as string,
					managementKey: config.descopeManagementKey,
				};
	const auth = createAuthService(authConfig);
	const oidcPolicies: TrustPolicyRepository | null = config.oidcEnabled
		? new PostgresTrustPolicyRepository(db)
		: null;
	const oidcService = oidcPolicies
		? new OidcExchangeService(new JwksValidatorImpl(), oidcPolicies, auth)
		: null;

	const storage = createBlobStorage(
		config.blobBackend === "local"
			? { backend: "local", basePath: config.blobLocalPath }
			: {
					backend: "s3",
					bucket: config.blobS3Bucket as string,
					endpoint: config.blobS3Endpoint,
					region: config.blobS3Region,
					accessKeyId: process.env.AWS_ACCESS_KEY_ID,
					secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
				},
	);

	const encryptionKey =
		config.encryptionKey ??
		(config.authMode === "dev"
			? devMasterKey()
			: (() => {
					throw new Error("PROCELLA_ENCRYPTION_KEY is required in production");
				})());
	const crypto = new AesCryptoService(encryptionKey);

	// Domain services
	const stacksService = new PostgresStacksService({ db });
	const updatesService = new PostgresUpdatesService({ db, storage, crypto });
	const auditService =
		authConfig.mode === "descope" && auth instanceof DescopeAuthService
			? new DescopeAuditService(auth.sdk)
			: new NoopAuditService();
	const webhooksService = new PostgresWebhooksService({ db });
	const githubConfig = buildGitHubAppConfig(config);
	const githubService = githubConfig
		? new OctokitGitHubService({ db, config: githubConfig })
		: null;
	const escService = new PostgresEscService({
		db,
		evaluator: new UnimplementedEvaluatorClient(),
		encryptionKeyHex: encryptionKey,
	});

	return {
		auth,
		authConfig,
		audit: auditService,
		corsOrigins: config.corsOrigins,
		db,
		dbUrl: config.databaseUrl,
		client,
		config,
		stacks: stacksService,
		updates: updatesService,
		webhooks: webhooksService,
		esc: escService,
		github: githubService,
		githubWebhookSecret: githubConfig?.webhookSecret,
		oidc: oidcService,
		oidcPolicies,
	};
}

/** Bootstrap with all routes — local dev + Vercel. */
export async function bootstrap() {
	const services = await bootstrapServices();
	const app = createApp(services);
	return {
		app,
		auth: services.auth,
		config: services.config,
		db: services.db,
		client: services.client,
	};
}

/** Bootstrap CLI-only routes — Pulumi CLI Lambda (buffered). */
export async function bootstrapCli() {
	const services = await bootstrapServices();
	const app = createCliApp(services);
	return {
		app,
		auth: services.auth,
		config: services.config,
		db: services.db,
		client: services.client,
	};
}

/** Bootstrap Web-only routes — dashboard Lambda (streaming). */
export async function bootstrapWeb() {
	const services = await bootstrapServices();
	const app = createWebApp(services);
	return {
		app,
		auth: services.auth,
		config: services.config,
		db: services.db,
		client: services.client,
	};
}
