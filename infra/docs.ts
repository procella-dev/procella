const isProd = $app.stage === "production";
const stage = $app.stage;

export const docs = new sst.aws.StaticSite("ProcellaDocs", {
	path: "apps/docs",
	build: {
		command: "bun run build",
		output: "dist",
	},
	domain: isProd ? "docs.procella.dev" : `docs.${stage}.procella.dev`,
});
