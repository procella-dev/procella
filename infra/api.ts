import { database, databaseUrl, vpc } from "./database";
import {
	allSecrets,
	descopeManagementKey,
	devAuthToken,
	encryptionKey,
	otelEndpoint,
	otelHeaders,
} from "./secrets";
import { bucket } from "./storage";

const isProd = $app.stage === "production";
const stage = $app.stage;

const descopeProjectId = !$dev ? (await import("./descope")).projectId : undefined;

const appOrigin = isProd ? "https://app.procella.cloud" : `https://app.${stage}.procella.cloud`;
const rootOrigin = isProd ? "https://procella.cloud" : `https://${stage}.procella.cloud`;

export const api = new sst.aws.Function("ProcellaCliApi", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/cli-api",
	handler: "bootstrap",
	url: {
		cors: false,
	},
	timeout: "60 seconds",
	memory: "512 MB",
	vpc,
	link: [database, bucket, ...allSecrets],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: $dev ? "dev" : "descope",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		PROCELLA_CORS_ORIGINS: `${appOrigin},${rootOrigin}`,
		PROCELLA_OTEL_ENABLED: "true",
		OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint.value,
		OTEL_EXPORTER_OTLP_HEADERS: otelHeaders.value,
		...($dev ? { PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value } : {}),
		...(!$dev
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

import * as command from "@pulumi/command";

export const migrateFn = new sst.aws.Function("ProcellaMigrate", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/migrate",
	handler: "bootstrap",
	timeout: "5 minutes",
	memory: "256 MB",
	vpc,
	link: [database, devAuthToken, encryptionKey],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_AUTH_MODE: "dev",
		PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value,
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
	},
});

if (!$dev) {
	const migrateCmd = $interpolate`aws lambda invoke --function-name ${migrateFn.name} --payload '{}' --cli-binary-format raw-in-base64-out --cli-read-timeout 360 /tmp/migrate-out-${stage}.json && cat /tmp/migrate-out-${stage}.json`;
	new command.local.Command("ProcellaMigrateRun", {
		create: migrateCmd,
		update: migrateCmd,
		triggers: [Date.now().toString()],
	});
}
