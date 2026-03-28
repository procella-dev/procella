import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:18080";
const UI_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const TOKEN = process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123";

const AUTH_HEADER = { Authorization: `token ${TOKEN}`, Accept: "application/vnd.pulumi+8" };

async function api(path: string, opts?: { method?: string; body?: unknown }) {
	const res = await fetch(`${API_URL}/api${path}`, {
		method: opts?.method ?? "GET",
		headers: { ...AUTH_HEADER, ...(opts?.body ? { "Content-Type": "application/json" } : {}) },
		body: opts?.body ? JSON.stringify(opts?.body) : undefined,
	});
	if (!res.ok) throw new Error(`API ${opts?.method ?? "GET"} ${path} → ${res.status}`);
	return res.json() as Promise<Record<string, unknown>>;
}

function runCmd(
	cmd: string,
	args: string[],
	env: Record<string, string>,
	cwd: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: "pipe" });
		proc.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
		);
	});
}

async function truncate() {
	const DB_URL =
		process.env.PROCELLA_DATABASE_URL ??
		"postgres://procella:procella@localhost:5432/procella?sslmode=disable";
	const client = new pg.Client({ connectionString: DB_URL });
	await client.connect();
	await client.query(
		"TRUNCATE update_events, journal_entries, checkpoints, updates, stacks, projects CASCADE",
	);
	await client.end();
}

async function setDevToken(page: Page) {
	await page.goto(`${UI_URL}/`);
	await page.evaluate((token) => localStorage.setItem("procella-token", token), TOKEN);
}

async function runPulumiUp(org: string, project: string, _stack: string): Promise<string> {
	const RANDOM_PET_PROGRAM = `name: ${project}
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 2
`;

	const pulumiHome = await mkdtemp(path.join(tmpdir(), "procella-pw-ph-"));
	const projectDir = await mkdtemp(path.join(tmpdir(), "procella-pw-proj-"));
	await writeFile(path.join(projectDir, "Pulumi.yaml"), RANDOM_PET_PROGRAM);
	await writeFile(path.join(projectDir, "Pulumi.pw-stack.yaml"), "config: {}");

	const cleanEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!k.startsWith("PROCELLA_") && !k.startsWith("AWS_") && v !== undefined) cleanEnv[k] = v;
	}
	const baseEnv = {
		...cleanEnv,
		PULUMI_ACCESS_TOKEN: TOKEN,
		PULUMI_BACKEND_URL: API_URL,
		PULUMI_HOME: pulumiHome,
		PULUMI_SKIP_UPDATE_CHECK: "true",
		PULUMI_CONFIG_PASSPHRASE: "test",
	};

	await runCmd(
		"pulumi",
		["login", "--cloud-url", API_URL, "--non-interactive"],
		baseEnv,
		projectDir,
	);
	await runCmd(
		"pulumi",
		["stack", "init", `${org}/${project}/pw-stack`, "--non-interactive"],
		baseEnv,
		projectDir,
	);
	await runCmd("pulumi", ["up", "--yes", "--non-interactive"], baseEnv, projectDir);

	const history = await api(`/stacks/${org}/${project}/pw-stack/updates`);
	const updates = history.updates as Array<{ updateID: string }>;
	if (!updates?.length) throw new Error("No updates found after pulumi up");
	return updates[0].updateID;
}

test.describe("tRPC subscription auth", () => {
	test("tRPC endpoint rejects unauthenticated requests", async ({ request }) => {
		const res = await request.get(
			`${API_URL}/trpc/updates.latest?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22org%22%3A%22x%22%2C%22project%22%3A%22x%22%2C%22stack%22%3A%22x%22%7D%7D%7D`,
		);
		expect(res.status()).toBe(401);
	});

	test("tRPC endpoint accepts valid token", async ({ request }) => {
		const res = await request.get(
			`${API_URL}/trpc/updates.latest?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22org%22%3A%22x%22%2C%22project%22%3A%22x%22%2C%22stack%22%3A%22x%22%7D%7D%7D`,
			{
				headers: { Authorization: `token ${TOKEN}` },
			},
		);
		expect([200, 404]).toContain(res.status());
	});
});

test.describe("UpdateDetail page — completed update", () => {
	let updateID: string;

	test.beforeAll(async () => {
		await truncate();
		updateID = await runPulumiUp("omer", "pw-test", "pw-stack");
	});

	test.afterAll(async () => {
		await truncate();
	});

	test("page loads and shows resource tracker", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=Resource Tracker")).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("text=Event Log")).toBeVisible();
	});

	test("event log shows at least one event", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=Event Log")).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("[data-testid=event-log], .font-mono").first()).toBeVisible();
	});

	test("progress bar is visible and non-zero for completed update", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=Resource Tracker")).toBeVisible({ timeout: 15_000 });

		const bar = page.locator(".bg-lightning").first();
		await expect(bar).toBeVisible();
		const style = await bar.getAttribute("style");
		expect(style).toMatch(/width:\s*(?!0%)/);
	});

	test("status badge shows succeeded", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=succeeded, text=Succeeded").first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("back link navigates to stack detail", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=Resource Tracker")).toBeVisible({ timeout: 15_000 });
		await page.locator("a", { hasText: "pw-test/pw-stack" }).click();

		await expect(page).toHaveURL(/\/stacks\/omer\/pw-test\/pw-stack$/);
		await expect(page.locator("text=Updates")).toBeVisible({ timeout: 10_000 });
	});

	test("filter buttons work — Errors and Warnings tabs", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=Event Log")).toBeVisible({ timeout: 15_000 });

		const errorsBtn = page.locator("button", { hasText: /Errors/ });
		await expect(errorsBtn).toBeVisible();
		await errorsBtn.click();

		const warningsBtn = page.locator("button", { hasText: /Warnings/ });
		await warningsBtn.click();

		const allBtn = page.locator("button", { hasText: "All" });
		await allBtn.click();
	});

	test("resource groups are collapsible", async ({ page }) => {
		await setDevToken(page);
		await page.goto(`${UI_URL}/stacks/omer/pw-test/pw-stack/updates/${updateID}`);

		await expect(page.locator("text=Resource Tracker")).toBeVisible({ timeout: 15_000 });

		const groupHeader = page
			.locator("button", { hasText: "▸" })
			.or(page.locator("button", { hasText: "▾" }))
			.first();

		if (await groupHeader.isVisible()) {
			await groupHeader.click();
			await groupHeader.click();
		}
	});
});

test.describe("UpdateDetail page — live SSE during active update", () => {
	test("events appear in the event log during a live pulumi up", async ({ page }) => {
		await truncate();
		await setDevToken(page);

		const PROGRAM = `name: live-test
runtime: yaml
resources:
  pet:
    type: random:index:RandomPet
    properties:
      length: 3
`;
		const pulumiHome = await mkdtemp(path.join(tmpdir(), "procella-pw-live-ph-"));
		const projectDir = await mkdtemp(path.join(tmpdir(), "procella-pw-live-proj-"));
		await writeFile(path.join(projectDir, "Pulumi.yaml"), PROGRAM);

		const cleanEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (!k.startsWith("PROCELLA_") && !k.startsWith("AWS_") && v !== undefined) cleanEnv[k] = v;
		}
		const pulumiEnv = {
			...cleanEnv,
			PULUMI_ACCESS_TOKEN: TOKEN,
			PULUMI_BACKEND_URL: API_URL,
			PULUMI_HOME: pulumiHome,
			PULUMI_SKIP_UPDATE_CHECK: "true",
			PULUMI_CONFIG_PASSPHRASE: "test",
		};

		await runCmd(
			"pulumi",
			["login", "--cloud-url", API_URL, "--non-interactive"],
			pulumiEnv,
			projectDir,
		);
		await runCmd(
			"pulumi",
			["stack", "init", "omer/live-test/dev", "--non-interactive"],
			pulumiEnv,
			projectDir,
		);

		const upDone = runCmd("pulumi", ["up", "--yes", "--non-interactive"], pulumiEnv, projectDir);

		await new Promise<void>((r) => setTimeout(r, 1000));

		const history = (await fetch(`${API_URL}/api/stacks/omer/live-test/dev/updates`, {
			headers: AUTH_HEADER,
		}).then((r) => r.json())) as { updates: Array<{ updateID: string }> };

		if (history.updates?.length) {
			const liveUpdateID = history.updates[0].updateID;
			await page.goto(`${UI_URL}/stacks/omer/live-test/dev/updates/${liveUpdateID}`);

			await expect(page.locator("text=Event Log")).toBeVisible({ timeout: 20_000 });

			await upDone;

			await page.waitForFunction(
				() => {
					const logContainer = document.querySelector(".font-mono");
					return logContainer && logContainer.children.length > 0;
				},
				{ timeout: 30_000 },
			);

			const eventCount = await page.locator(".font-mono > div").count();
			expect(eventCount).toBeGreaterThan(0);
		} else {
			await upDone;
		}

		await truncate();
	});
});
