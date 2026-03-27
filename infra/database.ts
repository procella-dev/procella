// VPC is required for Aurora even though Lambda accesses via Data API (HTTP).
// Using ec2 NAT (fck-nat) — 10x cheaper than managed NAT gateway.
export const vpc = new sst.aws.Vpc("ProcellaVpc", { nat: "ec2" });

export const database = new sst.aws.Aurora("ProcellaDatabase", {
	engine: "postgres",
	dataApi: true,
	scaling: {
		min: "0.5 ACU",
		max: "16 ACU",
	},
	vpc,
	// In `sst dev`, connect to local Docker PostgreSQL instead of deploying Aurora.
	dev: {
		username: "procella",
		password: "procella",
		database: "procella",
		host: "localhost",
		port: 5432,
	},
});
