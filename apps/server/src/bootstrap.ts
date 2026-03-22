// @procella/server — Shared bootstrap logic for both Bun.serve and Vercel.
//
// Creates all services and the Hono app. Called once at module load time
// in both entry points (index.ts for local dev, vercel.ts for production).

import { createAuthService } from "@procella/auth";
import { loadConfig } from "@procella/config";
import { AesCryptoService, devMasterKey } from "@procella/crypto";
import { createDb } from "@procella/db";
import { PostgresStacksService } from "@procella/stacks";
import { createBlobStorage } from "@procella/storage";
import { PostgresUpdatesService } from "@procella/updates";
import { createApp } from "./routes/index.js";

const config = loadConfig();

// Database
const { db, client } = await createDb({ url: config.databaseUrl });

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

// Storage
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

// Encryption
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

// Hono app
export const app = createApp({
	auth,
	authConfig,
	corsOrigins: config.corsOrigins,
	db,
	stacks: stacksService,
	updates: updatesService,
});

export { auth, config, db, client };
