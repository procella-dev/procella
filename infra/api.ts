import { database } from "./database";
import { bucket } from "./storage";
import {
	allSecrets,
	encryptionKey,
	devAuthToken,
	descopeProjectId,
	descopeManagementKey,
} from "./secrets";

const isProd = $app.stage === "production";
const stage = $app.stage;

const dbEnv = $dev
	? {
			PROCELLA_DATABASE_URL: $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${database.database}`,
		}
	: {
			PROCELLA_DATABASE_DRIVER: "data-api",
			PROCELLA_DATABASE_SECRET_ARN: database.secretArn,
			PROCELLA_DATABASE_CLUSTER_ARN: database.clusterArn,
			PROCELLA_DATABASE_NAME: database.database,
		};

export const api = new sst.aws.Function("ProcellaApi", {
	handler: "apps/server/src/lambda.handler",
	url: true,
	timeout: "60 seconds",
	memory: "512 MB",
	link: [database, bucket, ...allSecrets],
	environment: {
		...dbEnv,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: isProd ? "descope" : "dev",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		...(!isProd ? { PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value } : {}),
		...(isProd
			? {
					PROCELLA_DESCOPE_PROJECT_ID: descopeProjectId.value,
					PROCELLA_DESCOPE_MANAGEMENT_KEY: descopeManagementKey.value,
				}
			: {}),
	},
	nodejs: {
		esbuild: {
			external: ["bun"],
		},
	},
});

export const router = new sst.aws.Router("ProcellaRouter", {
	domain: isProd ? "api.procella.dev" : `api.${stage}.procella.dev`,
	routes: {
		"/*": api.url,
	},
});
