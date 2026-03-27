import { database, databaseName } from "./database";
import { bucket } from "./storage";
import { allSecrets, encryptionKey, devAuthToken } from "./secrets";

const isProd = $app.stage === "production";

const dbEnv = $dev
	? {
			PROCELLA_DATABASE_URL: $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${database.database}`,
		}
	: {
			PROCELLA_DATABASE_DRIVER: "data-api",
			PROCELLA_DATABASE_SECRET_ARN: database.secretArn,
			PROCELLA_DATABASE_CLUSTER_ARN: database.clusterArn,
			PROCELLA_DATABASE_NAME: databaseName,
		};

const gcFunction = new sst.aws.Function("ProcellaGc", {
	handler: "apps/server/src/gc-handler.handler",
	timeout: "60 seconds",
	memory: "256 MB",
	link: [database, bucket, ...allSecrets],
	environment: {
		...dbEnv,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_AUTH_MODE: isProd ? "descope" : "dev",
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		...(!isProd ? { PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value } : {}),
	},
	nodejs: {
		esbuild: {
			external: ["bun"],
		},
	},
});

export const gc = new sst.aws.Cron("ProcellaGcCron", {
	schedule: "rate(1 minute)",
	job: gcFunction,
});
