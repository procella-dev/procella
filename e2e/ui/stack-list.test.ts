import { type Page, test } from "@playwright/test";

const UI_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const TOKEN = process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123";

async function setDevToken(page: Page) {
	await page.goto(`${UI_URL}/`);
	await page.evaluate((token) => localStorage.setItem("procella-token", token), TOKEN);
}

test.describe("Stack List Page", () => {
	test.beforeEach(async ({ page }) => {
		await setDevToken(page);
	});

	test("loads without server errors", async ({ page }) => {
		const response = await page.goto(`${UI_URL}/`);
		await page.waitForLoadState("domcontentloaded");
		if (response && response.status() >= 500) throw new Error(`Server error: ${response.status()}`);
	});
});
