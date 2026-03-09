/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "strata",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				// Descope Pulumi provider — manages Descope project config as code.
				// Credentials: set DESCOPE_MANAGEMENT_KEY env var or run:
				//   sst secret set DescopeManagementKey <your-key>
				"@descope/pulumi-descope": "0.3.4",
			},
		};
	},
	async run() {
		const descope = await import("./infra/descope");
		return {
			DescopeProjectId: descope.descopeProjectId,
		};
	},
});
