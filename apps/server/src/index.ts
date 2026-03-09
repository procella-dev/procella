// @strata/server — Hono HTTP server entrypoint.

import { createAuthService } from "@strata/auth";
import { loadConfig } from "@strata/config";
import { AesCryptoService, devMasterKey } from "@strata/crypto";
import { createDb } from "@strata/db";
import { PostgresStacksService } from "@strata/stacks";
import { createBlobStorage } from "@strata/storage";
import { GCWorker, PostgresUpdatesService } from "@strata/updates";
import { createApp } from "./routes/index.js";

// ============================================================================
// Bootstrap
// ============================================================================

const config = loadConfig();

// Database
const { db, client } = createDb({ url: config.databaseUrl });

// Services
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

const storage = createBlobStorage(
	config.blobBackend === "local"
		? { backend: "local", basePath: config.blobLocalPath }
		: {
				backend: "s3",
				bucket: config.blobS3Bucket as string,
				endpoint: config.blobS3Endpoint,
				region: config.blobS3Region,
				accessKeyId: (Bun.env.AWS_ACCESS_KEY_ID ?? "") as string,
				secretAccessKey: (Bun.env.AWS_SECRET_ACCESS_KEY ?? "") as string,
			},
);

const encryptionKey =
	config.encryptionKey ??
	(config.authMode === "dev"
		? devMasterKey()
		: (() => {
				throw new Error("STRATA_ENCRYPTION_KEY is required in production");
			})());
const crypto = new AesCryptoService(encryptionKey);

const stacksService = new PostgresStacksService({ db });
const updatesService = new PostgresUpdatesService({ db, storage, crypto });

// HTTP
const app = createApp({
	auth,
	authConfig,
	corsOrigins: config.corsOrigins,
	db,
	stacks: stacksService,
	updates: updatesService,
});

const [, portStr] = config.listenAddr.split(":");
const port = Number.parseInt(portStr || "9090", 10);

const server = Bun.serve({
	fetch: app.fetch,
	port,
	hostname: "0.0.0.0",
});

// biome-ignore lint/suspicious/noConsole: server startup log
console.log(`Strata listening on ${server.hostname}:${server.port}`);

// GC Worker
const gc = new GCWorker({ db });
gc.start();

// Graceful shutdown — stop accepting new connections, drain in-flight requests,
// then force-close after timeout.
const DRAIN_TIMEOUT_MS = 10_000;
const shutdown = async () => {
	await server.stop();
	await gc.stop();
	setTimeout(() => {
		server.stop(true);
		client.close();
		process.exit(1);
	}, DRAIN_TIMEOUT_MS).unref();
	client.close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
