export const site = new sst.aws.StaticSite("ProcellaSite", {
	path: "apps/ui",
	build: {
		command: "bun run build",
		output: "dist",
	},
});
