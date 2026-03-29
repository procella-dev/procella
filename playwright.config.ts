import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:18080";

export default defineConfig({
	testDir: "./e2e/ui",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",

	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		extraHTTPHeaders: {
			Authorization: `token ${process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123"}`,
		},
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	globalSetup: "./e2e/ui/global-setup.ts",
});

export { API_URL, BASE_URL };
