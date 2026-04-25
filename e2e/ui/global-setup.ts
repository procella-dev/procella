import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import pg from "pg";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const TEST_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 18_080);
const UI_PORT = 5173;
const TEST_DB_URL =
	process.env.PROCELLA_DATABASE_URL ??
	"postgres://procella:procella@localhost:5432/procella?sslmode=disable";
const TEST_TOKEN = process.env.PROCELLA_DEV_AUTH_TOKEN ?? "devtoken123";
const ESC_EVAL_BOOTSTRAP = path.join(PROJECT_ROOT, ".build", "esc-eval", "bootstrap");

function sleep(ms: number) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(url);
			if (r.ok || r.status < 500) return;
		} catch {}
		await sleep(300);
	}
	throw new Error(`Timed out waiting for ${url}`);
}

async function isListening(port: number, path = "/healthz"): Promise<boolean> {
	try {
		const r = await fetch(`http://localhost:${port}${path}`, {
			signal: AbortSignal.timeout(500),
		});
		return r.ok || r.status < 500;
	} catch {
		return false;
	}
}

async function resetDb(): Promise<void> {
	const client = new pg.Client({ connectionString: TEST_DB_URL });
	await client.connect();
	await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
	await client.query("DROP SCHEMA public CASCADE");
	await client.query("CREATE SCHEMA public");
	await client.end();
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(
			"bunx",
			["drizzle-kit", "migrate", "--config", "packages/db/drizzle.config.ts"],
			{
				env: { ...process.env, PROCELLA_DATABASE_URL: TEST_DB_URL },
				cwd: PROJECT_ROOT,
				stdio: "pipe",
			},
		);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`drizzle-kit migrate failed (exit ${code})`));
		});
	});
}

async function ensureEscEvaluatorBinary(): Promise<string> {
	try {
		await access(ESC_EVAL_BOOTSTRAP);
		return ESC_EVAL_BOOTSTRAP;
	} catch {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn("make", ["build"], {
				cwd: path.join(PROJECT_ROOT, "esc-eval"),
				stdio: "pipe",
			});
			proc.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`esc-eval make build failed (exit ${code})`));
			});
		});
		return ESC_EVAL_BOOTSTRAP;
	}
}

export default async function globalSetup(_config: FullConfig) {
	const blobDir = await mkdtemp(path.join(tmpdir(), "procella-pw-blobs-"));
	const escEvaluatorBinary = await ensureEscEvaluatorBinary();

	const apiAlreadyUp = await isListening(TEST_PORT);
	if (!apiAlreadyUp) {
		await resetDb();
		const server = spawn("bun", ["run", "apps/server/src/index.ts"], {
			env: {
				...process.env,
				PROCELLA_LISTEN_ADDR: `:${TEST_PORT}`,
				PROCELLA_DATABASE_URL: TEST_DB_URL,
				PROCELLA_AUTH_MODE: "dev",
				PROCELLA_DEV_AUTH_TOKEN: TEST_TOKEN,
				PROCELLA_BLOB_BACKEND: "local",
				PROCELLA_BLOB_LOCAL_PATH: blobDir,
				PROCELLA_ESC_EVALUATOR_BINARY: escEvaluatorBinary,
			},
			cwd: PROJECT_ROOT,
			stdio: "ignore",
		});
		// biome-ignore lint/suspicious/noExplicitAny: storing on global for teardown
		(globalThis as any).__PW_SERVER__ = server;
		await waitFor(`http://localhost:${TEST_PORT}/healthz`, 30_000);
	}

	const uiAlreadyUp = await isListening(UI_PORT, "/").catch(() => false);
	if (!uiAlreadyUp) {
		const ui = spawn(
			"bun",
			["run", "--cwd", "apps/ui", "dev", "--port", String(UI_PORT), "--strictPort"],
			{
				env: { ...process.env, VITE_API_PORT: String(TEST_PORT) },
				cwd: PROJECT_ROOT,
				stdio: "ignore",
			},
		);
		// biome-ignore lint/suspicious/noExplicitAny: storing on global for teardown
		(globalThis as any).__PW_UI__ = ui;
		await waitFor(`http://localhost:${UI_PORT}`, 30_000);
	}
}
