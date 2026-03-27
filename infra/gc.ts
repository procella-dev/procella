import { database } from "./database";
import { bucket } from "./storage";
import { allSecrets, encryptionKey, devAuthToken } from "./secrets";

const isProd = $app.stage === "production";

const gcFunction = new sst.aws.Function("ProcellaGc", {
	handler: "apps/server/src/gc-handler.handler",
	timeout: "60 seconds",
	memory: "256 MB",
	link: [database, bucket, ...allSecrets],
	environment: {
		PROCELLA_DATABASE_DRIVER: "data-api",
		PROCELLA_DATABASE_SECRET_ARN: database.secretArn,
		PROCELLA_DATABASE_CLUSTER_ARN: database.clusterArn,
		PROCELLA_DATABASE_NAME: database.database,
		PROCELLA_BLOB_BACKEND: "s3",
		PROCELLA_BLOB_S3_BUCKET: bucket.name,
		PROCELLA_BLOB_S3_REGION: "us-east-1",
		PROCELLA_AUTH_MODE: isProd ? "descope" : "dev",
		PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value,
		PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
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
