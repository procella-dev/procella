import { expect, type Page, test } from "@playwright/test";

const UI_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:18080";
const TOKEN = process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123";

const ESC_HEADERS = {
	Authorization: `token ${TOKEN}`,
	Accept: "application/vnd.pulumi+8",
	"Content-Type": "application/json",
};

async function setDevToken(page: Page) {
	await page.goto(`${UI_URL}/`);
	await page.evaluate((token) => localStorage.setItem("procella-token", token), TOKEN);
}

async function createEscEnvironment(project: string, name: string, yamlBody: string) {
	// Step 1: Create empty environment (matches upstream esc CLI wire contract).
	const createRes = await fetch(`${API_URL}/api/esc/environments/dev-org`, {
		method: "POST",
		headers: ESC_HEADERS,
		body: JSON.stringify({ project, name }),
	});
	if (!createRes.ok) {
		throw new Error(`Create env failed: ${createRes.status} ${await createRes.text()}`);
	}
	// Step 2: PATCH the YAML body (sent as raw text, not JSON).
	if (yamlBody) {
		const patchRes = await fetch(
			`${API_URL}/api/esc/environments/dev-org/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `token ${TOKEN}`,
					Accept: "application/vnd.pulumi+8",
					"Content-Type": "application/x-yaml",
				},
				body: yamlBody,
			},
		);
		if (!patchRes.ok) {
			throw new Error(`Patch env failed: ${patchRes.status} ${await patchRes.text()}`);
		}
	}
}

test.describe("ESC Environments List", () => {
	test.beforeEach(async ({ page }) => {
		await setDevToken(page);
	});

	test("page loads and shows empty state", async ({ page }) => {
		await page.goto(`${UI_URL}/esc`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByRole("heading", { name: "Environments", exact: true })).toBeVisible();
	});

	test("shows environment after API creation", async ({ page }) => {
		const ts = Date.now();
		await createEscEnvironment(`pw-list-${ts}`, `dev-${ts}`, "values:\n  greeting: hello\n");
		await page.goto(`${UI_URL}/esc`);
		await expect(page.getByText(`dev-${ts}`)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(`pw-list-${ts}`)).toBeVisible();
	});

	test("row click navigates to detail page", async ({ page }) => {
		const ts = Date.now();
		const project = `pw-nav-${ts}`;
		const envName = `staging-${ts}`;
		await createEscEnvironment(project, envName, "values:\n  key: val\n");
		await page.goto(`${UI_URL}/esc`);
		await page.getByText(envName).click({ timeout: 10_000 });
		await page.waitForURL(`**/esc/${project}/${envName}`);
	});
});
