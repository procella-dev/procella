const stage = $app.stage;

export const vpc = await aws.ec2
	.getVpc({ tags: { "sst:app": $app.name } })
	.catch(() => undefined)
	.then(async (existing) => {
		if (existing && existing.tags?.["sst:stage"] !== stage) {
			return sst.aws.Vpc.get("ProcellaVpc", existing.id);
		}
		return new sst.aws.Vpc("ProcellaVpc", { nat: "ec2" });
	});

export const database = await aws.rds
	.getClusters({
		filters: [{ name: "tag:sst:app", values: [$app.name] }],
	})
	.catch(() => undefined)
	.then(async (result) => {
		const clusterId = result?.clusterIdentifiers?.[0];
		if (!$dev && clusterId) {
			return sst.aws.Aurora.get("ProcellaDatabase", clusterId);
		}
		return new sst.aws.Aurora("ProcellaDatabase", {
			engine: "postgres",
			proxy: true,
			scaling: { min: "0.5 ACU", max: "16 ACU" },
			vpc,
			dev: {
				username: "procella",
				password: "procella",
				database: "procella",
				host: "localhost",
				port: 5432,
			},
		});
	});

export const databaseName = $dev
	? "procella"
	: stage === "production"
		? "procella"
		: `procella_${stage.replace(/-/g, "_")}`;

export const databaseUrl = $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${databaseName}`;
