import { database, databaseUrl, vpc } from "./database";
import { allSecrets, devAuthToken, encryptionKey } from "./secrets";
import { bucket } from "./storage";

export const gc = new sst.aws.Cron("ProcellaGcCron", {
	schedule: "rate(1 minute)",
	job: {
		runtime: "provided.al2023",
		architecture: "x86_64",
		bundle: ".build/gc",
		handler: "bootstrap",
		timeout: "60 seconds",
		memory: "256 MB",
		vpc,
		link: [database, bucket, ...allSecrets],
		environment: {
			PROCELLA_DATABASE_URL: databaseUrl,
			PROCELLA_BLOB_BACKEND: "s3",
			PROCELLA_BLOB_S3_BUCKET: bucket.name,
			PROCELLA_AUTH_MODE: "dev",
			PROCELLA_DEV_AUTH_TOKEN: devAuthToken.value,
			PROCELLA_ENCRYPTION_KEY: encryptionKey.value,
		},
	},
});
