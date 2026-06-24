import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TEST_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 18_080);
const STATE_PATH = path.join(tmpdir(), `procella-playwright-${TEST_PORT}.json`);

interface SetupState {
	blobDir?: string;
	serverPid?: number;
	uiPid?: number;
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isSetupState(value: unknown): value is SetupState {
	return typeof value === "object" && value !== null;
}

async function stopPid(pid: number | undefined): Promise<void> {
	if (!pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	await sleep(5000);
	try {
		process.kill(pid, 0);
		process.kill(pid, "SIGKILL");
	} catch {}
}

export default async function globalTeardown() {
	const raw = await readFile(STATE_PATH, "utf8").catch(() => "{}");
	const parsed: unknown = JSON.parse(raw);
	const state = isSetupState(parsed) ? parsed : {};

	await stopPid(state.uiPid);
	await stopPid(state.serverPid);
	if (state.blobDir) await rm(state.blobDir, { recursive: true, force: true });
	await rm(STATE_PATH, { force: true });
}
