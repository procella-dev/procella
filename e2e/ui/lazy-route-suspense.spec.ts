import { expect, test } from "@playwright/test";

const UI_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

const PUBLIC_LAZY_ROUTES = [
	{ path: "/cli-login", expectedText: /Procella|Authorize|CLI/i },
	{ path: "/welcome/cli", expectedText: /Procella|CLI|Welcome|Logged in|Token/i },
	{ path: "/design", expectedText: /Design|Procella|Component|Tokens|Color/i },
];

test.describe("Lazy routes render without Suspense crash", () => {
	for (const { path, expectedText } of PUBLIC_LAZY_ROUTES) {
		test(`${path} loads its lazy chunk and renders`, async ({ page }) => {
			const consoleErrors: string[] = [];
			page.on("pageerror", (err) => {
				consoleErrors.push(err.message);
			});

			await page.goto(`${UI_URL}${path}`);
			await page.waitForLoadState("networkidle");

			const suspendedErrors = consoleErrors.filter((msg) =>
				/component suspended while rendering|Suspense boundary/i.test(msg),
			);
			expect(suspendedErrors).toEqual([]);

			await expect(page.locator("body")).toContainText(expectedText, { timeout: 10_000 });
		});
	}
});
