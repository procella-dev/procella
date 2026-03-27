/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "procella",
			removal: input.stage === "production" ? "retain" : "remove",
			protect: input.stage === "production",
			home: "aws",
			providers: {
				"@descope/pulumi-descope": "0.3.4",
			},
		};
	},
	async run() {
		await import("./infra/secrets");
		await import("./infra/database");
		await import("./infra/storage");
		const { api } = await import("./infra/api");
		await import("./infra/gc");
		const { site } = await import("./infra/site");

		return {
			api: api.url,
			site: site.url,
		};
	},
});
