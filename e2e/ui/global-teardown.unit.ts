import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import globalTeardown, { parseSetupState } from "./global-teardown";

const STATE_PATH = path.join(tmpdir(), "procella-playwright-18080.json");

describe("Playwright global teardown", () => {
	test("does not throw when setup state file is empty", async () => {
		await writeFile(STATE_PATH, "", "utf8");

		await expect(globalTeardown()).resolves.toBeUndefined();
	});

	test("falls back to empty state when setup state JSON is corrupt", () => {
		expect(parseSetupState("not-json")).toEqual({});
	});
});
