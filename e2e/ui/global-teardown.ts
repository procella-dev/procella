import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TEST_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 18_080);
const STATE_PATH = path.join(tmpdir(), `procella-playwright-${TEST_PORT}.json`);

type UnknownRecord = { readonly [key: string]: unknown };

export interface SetupState {
	readonly blobDir?: string;
	readonly serverPid?: number;
	readonly uiPid?: number;
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return isUnknownRecord(error) && error.code === code;
}

function decodeSetupState(value: unknown): SetupState {
	if (!isUnknownRecord(value)) return {};

	const blobDir = value.blobDir;
	const serverPid = value.serverPid;
	const uiPid = value.uiPid;

	return {
		...(typeof blobDir === "string" ? { blobDir } : {}),
		...(typeof serverPid === "number" ? { serverPid } : {}),
		...(typeof uiPid === "number" ? { uiPid } : {}),
	};
}

export function parseSetupState(raw: string): SetupState {
	try {
		const parsed: unknown = JSON.parse(raw);
		return decodeSetupState(parsed);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

async function stopPid(pid: number | undefined): Promise<void> {
	if (!pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if (hasErrorCode(error, "ESRCH")) return;
		throw error;
	}
	await sleep(5000);
	try {
		process.kill(pid, 0);
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (hasErrorCode(error, "ESRCH")) return;
		throw error;
	}
}

export default async function globalTeardown() {
	const raw = await readFile(STATE_PATH, "utf8").catch((error: unknown) => {
		if (hasErrorCode(error, "ENOENT")) return "{}";
		throw error;
	});
	const state = parseSetupState(raw);

	await stopPid(state.uiPid);
	await stopPid(state.serverPid);
	if (state.blobDir) await rm(state.blobDir, { recursive: true, force: true });
	await rm(STATE_PATH, { force: true });
}
