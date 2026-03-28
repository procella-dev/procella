import { vpc, database, databaseUrl } from "./database";
import { bucket } from "./storage";
import {
	allSecrets,
	encryptionKey,
	devAuthToken,
	descopeManagementKey,
} from "./secrets";

const isProd = $app.stage === "production";
const stage = $app.stage;

const descopeProjectId = isProd
	? (await import("./descope")).projectId
	: undefined;

export const api = new sst.aws.Function("ProcellaApi", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/api",
	handler: "bootstrap",
	url: true,
	timeout: "60 seconds",
	memory: "512 MB",
	vpc,
	link: [database, bucket, ...allSecrets],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: isProd ? "descope" : "dev",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		...(!isProd ? { PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value } : {}),
		...(isProd
			? {
					PROCELLA_DESCOPE_PROJECT_ID: descopeProjectId,
					PROCELLA_DESCOPE_MANAGEMENT_KEY: descopeManagementKey.value,
				}
			: {}),
	},
});

export const router = new sst.aws.Router("ProcellaRouter", {
	domain: isProd ? "api.procella.cloud" : `api.${stage}.procella.cloud`,
	routes: {
		"/*": api.url,
	},
});

export const migrateFn = new sst.aws.Function("ProcellaMigrate", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/migrate",
	handler: "bootstrap",
	timeout: "5 minutes",
	memory: "256 MB",
	vpc,
	link: [database, ...allSecrets],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_AUTH_MODE: "dev",
		PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value,
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
	},
});
