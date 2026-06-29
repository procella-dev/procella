import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_PATH = resolve(import.meta.dir, "Layout.tsx");
const source = readFileSync(SOURCE_PATH, "utf-8");

describe("Layout", () => {
	test("keeps dev token label accessible on mobile", () => {
		expect(source).toContain("sr-only sm:not-sr-only sm:inline");
		expect(source).not.toContain("hidden sm:inline text-sm font-medium text-cloud");
	});
});
