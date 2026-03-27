/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "procella",
			removal: input.stage === "production" ? "retain" : "remove",
			protect: input.stage === "production",
			home: "aws",
			providers: {
				aws: { region: "us-east-1", version: "7.20.0" },
				"@descope/pulumi-descope": "0.3.4",
			},
		};
	},
	async run() {
		await import("./infra/secrets");
		await import("./infra/database");
		await import("./infra/storage");
		await import("./infra/descope");
		const { router } = await import("./infra/api");
		await import("./infra/gc");
		const { site } = await import("./infra/site");
		const { docs } = await import("./infra/docs");

		const { database, databaseName } = await import("./infra/database");

		return {
			api: router.url,
			app: site.url,
			docs: docs.url,
			clusterArn: database.clusterArn,
			secretArn: database.secretArn,
			databaseName,
		};
	},
});
