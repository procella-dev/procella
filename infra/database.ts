const stage = $app.stage;
const isProd = stage === "production";

export const vpc = !isProd
	? await aws.ec2
			.getVpc({ tags: { "sst:app": $app.name, "sst:stage": "production" } })
			.then((existing) => sst.aws.Vpc.get("ProcellaVpc", existing.id))
	: new sst.aws.Vpc("ProcellaVpc", { nat: "ec2" });

export const database = !isProd
	? await aws.rds
			.getClusters({})
			.then(
				(clusters) =>
					clusters.clusterIdentifiers.find((id) => id.startsWith("procella-production")) ||
					(() => {
						throw new Error("Production database not found");
					})(),
			)
			.then((existing) => sst.aws.Aurora.get("ProcellaDatabase", existing))
	: new sst.aws.Aurora("ProcellaDatabase", {
			engine: "postgres",
			dataApi: true,
			scaling: { min: "0 ACU", max: "16 ACU", pauseAfter: "5 minutes" },
			vpc,
			transform: {
				cluster: {
					storageType: "aurora-iopt1",
				},
			},
			dev: {
				username: "procella",
				password: "procella",
				database: "procella",
				host: "localhost",
				port: 5432,
			},
		});

export const databaseName = $dev
	? "procella"
	: stage === "production"
		? "procella"
		: `procella_${stage.replace(/-/g, "_")}`;

export const databaseUrl = $dev
	? $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${databaseName}`
	: $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${databaseName}?sslmode=require`;
