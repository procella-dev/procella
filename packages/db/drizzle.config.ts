import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./packages/db/src/schema.ts",
	out: "./packages/db/drizzle",
	dialect: "postgresql",
	dbCredentials: {
		// biome-ignore lint/style/noNonNullAssertion: required env var, validated at runtime
		url: process.env.STRATA_DATABASE_URL!,
	},
});
