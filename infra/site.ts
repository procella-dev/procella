import { api } from "./api";

export const site = new sst.aws.StaticSite("ProcellaSite", {
	path: "apps/ui",
	build: {
		command: "bun run build",
		output: "dist",
	},
	environment: {
		VITE_API_URL: api.url,
	},
});
