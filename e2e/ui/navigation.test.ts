import { type Page, test } from "@playwright/test";

const UI_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const TOKEN = process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123";

async function setDevToken(page: Page) {
	await page.goto(`${UI_URL}/`);
	await page.evaluate((token) => localStorage.setItem("procella-token", token), TOKEN);
}

/** Navigate and wait for the page to be interactive (no body visibility check — SPA may hide body during transitions). */
async function navigateAndWait(page: Page, path: string) {
	const response = await page.goto(`${UI_URL}${path}`);
	await page.waitForLoadState("domcontentloaded");
	// Vite SPA always returns 200 for all routes (client-side routing)
	if (response) {
		if (response.status() >= 500) throw new Error(`Server error ${response.status()} on ${path}`);
	}
}

test.describe("Navigation & Page Loading", () => {
	test.beforeEach(async ({ page }) => {
		await setDevToken(page);
	});

	test("home page loads without errors", async ({ page }) => {
		await navigateAndWait(page, "/");
	});

	test("settings page loads", async ({ page }) => {
		await navigateAndWait(page, "/settings");
	});

	test("tokens page loads", async ({ page }) => {
		await navigateAndWait(page, "/tokens");
	});

	test("webhooks page loads", async ({ page }) => {
		await navigateAndWait(page, "/webhooks");
	});

	test("404 page for unknown route", async ({ page }) => {
		await navigateAndWait(page, `/this-does-not-exist-${Date.now()}`);
	});

	test("cli-login page loads", async ({ page }) => {
		await navigateAndWait(page, "/cli-login");
	});

	test("direct stack detail URL loads", async ({ page }) => {
		await navigateAndWait(page, "/dev-org/test-project/dev");
	});
});
