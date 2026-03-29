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

let clusterDirectHost: string | undefined;

export const database = await (async () => {
	if ($dev || stage === "production") {
		return new sst.aws.Aurora("ProcellaDatabase", {
			engine: "postgres",
			dataApi: true,
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
	}

	const result = await aws.rds.getClusters({}).catch((err) => {
		throw new Error(
			`Preview stage ${stage} cannot deploy without a production Aurora cluster. getClusters failed: ${err}`,
		);
	});
	const clusterId = result.clusterIdentifiers.find((id) =>
		id.startsWith(`${$app.name}-production-`),
	);
	if (!clusterId) {
		throw new Error(
			`Preview stage ${stage}: no production Aurora cluster found (expected name starting with "${$app.name}-production-"). ` +
				`Available clusters: ${result.clusterIdentifiers.join(", ") || "none"}`,
		);
	}
	const cluster = await aws.rds.getCluster({ clusterIdentifier: clusterId });
	clusterDirectHost = cluster.endpoint;
	return sst.aws.Aurora.get("ProcellaDatabase", clusterId);
})();

export const databaseName = $dev
	? "procella"
	: stage === "production"
		? "procella"
		: `procella_${stage.replace(/-/g, "_")}`;

const dbHost = clusterDirectHost ?? database.host;

export const databaseUrl = $dev
	? $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${databaseName}`
	: $interpolate`postgresql://${database.username}:${database.password}@${dbHost}:${database.port}/${databaseName}?sslmode=require`;
