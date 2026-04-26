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

test.describe("ESC Environment Editor", () => {
	const ts = Date.now();
	const project = `pw-editor-${ts}`;
	const envName = `dev-${ts}`;

	test.beforeAll(async () => {
		await createEscEnvironment(project, envName, "values:\n  key: original\n");
	});

	test.beforeEach(async ({ page }) => {
		await setDevToken(page);
	});

	test("loads environment YAML in editor", async ({ page }) => {
		await page.goto(`${UI_URL}/esc/${project}/${envName}`);
		await page.waitForLoadState("networkidle");
		await expect(page.getByRole("button", { name: "Save" })).toBeVisible({ timeout: 15_000 });
		const textarea = page.locator("textarea");
		await expect(textarea).toBeVisible({ timeout: 15_000 });
		await expect(textarea).toContainText("original");
	});

	test("edit YAML and save bumps revision", async ({ page }) => {
		await page.goto(`${UI_URL}/esc/${project}/${envName}`);
		await page.waitForLoadState("networkidle");
		const textarea = page.locator("textarea");
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		await textarea.fill("values:\n  key: modified\n");
		await page.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("rev #2")).toBeVisible({ timeout: 15_000 });
	});
});
