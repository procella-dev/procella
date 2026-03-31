// Web API Lambda — tRPC dashboard routes + SSE subscriptions.
//
// Served from the same CloudFront distribution as the static site (app. domain)
// via ordered cache behaviors in infra/site.ts. Streaming enabled for SSE.

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

const descopeProjectId = !$dev ? (await import("./descope")).projectId : undefined;

const isProd = $app.stage === "production";

export const webApi = new sst.aws.Function("ProcellaWebApi", {
	runtime: "provided.al2023",
	architecture: "x86_64",
	bundle: ".build/web-api",
	handler: "bootstrap",
	streaming: true,
	url: {
		cors: false,
	},
	timeout: "60 seconds",
	memory: "512 MB",
	// Provisioned concurrency eliminates cold starts for the dashboard API.
	...(isProd ? { concurrency: { provisioned: 1 } } : {}),
	vpc,
	link: [database, bucket, ...allSecrets],
	environment: {
		PROCELLA_DATABASE_URL: databaseUrl,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: $dev ? "dev" : "descope",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
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
