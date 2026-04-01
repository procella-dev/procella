import { expect, type Page, test } from "@playwright/test";

const UI_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:18080";
const TOKEN = process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123";
const AUTH_HEADER = { Authorization: `token ${TOKEN}`, Accept: "application/vnd.pulumi+8" };

async function setDevToken(page: Page) {
	await page.goto(`${UI_URL}/`);
	await page.evaluate((token) => localStorage.setItem("procella-token", token), TOKEN);
}

async function createStack(org: string, project: string, stack: string) {
	const res = await fetch(`${API_URL}/api/stacks/${org}/${project}/${stack}`, {
		method: "POST",
		headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	if (!res.ok) throw new Error(`createStack failed: ${res.status}`);
}

test.describe("Stack List Page", () => {
	test.beforeEach(async ({ page }) => {
		await setDevToken(page);
	});

	test("loads the stack list page", async ({ page }) => {
		const response = await page.goto(`${UI_URL}/`);
		await page.waitForLoadState("domcontentloaded");
		if (response && response.status() >= 500) throw new Error(`Server error: ${response.status()}`);
	});

	test("displays stacks after creation", async ({ page }) => {
		const stackName = `pw-list-${Date.now()}`;
		await createStack("dev-org", "test-project", stackName);

		const response = await page.goto(`${UI_URL}/`);
		await page.waitForLoadState("domcontentloaded");
		if (response && response.status() >= 500) throw new Error(`Server error: ${response.status()}`);

		// Wait for stack name to appear in the page
		await expect(page.getByText(stackName).first()).toBeVisible({ timeout: 10_000 });
	});

	test("navigates to stack detail when clicking a stack", async ({ page }) => {
		const stackName = `pw-nav-${Date.now()}`;
		await createStack("dev-org", "test-project", stackName);

		await page.goto(`${UI_URL}/`);
		await page.waitForLoadState("domcontentloaded");

		// Wait for and click the stack link
		const stackLink = page.getByText(stackName).first();
		await expect(stackLink).toBeVisible({ timeout: 5000 });
		await stackLink.click();
		await page.waitForLoadState("networkidle");
		expect(page.url()).toContain(stackName);
	});
});
