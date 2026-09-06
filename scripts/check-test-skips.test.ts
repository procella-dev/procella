import { describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkTestSkips,
	collectSkippedTests,
	EXPECTED_SKIP_FILES,
	findUnexpectedSkips,
	parseSkipGuardArguments,
} from "./check-test-skips.ts";

function report(testCases: string): string {
	return `<testsuites><testsuite name="suite">${testCases}</testsuite></testsuites>`;
}

function skippedTest(file: string, name = "skipped test"): string {
	return `<testcase name="${name}" file="${file}"><skipped /></testcase>`;
}

async function writeReport(testCases: string): Promise<string> {
	const path = join(tmpdir(), `procella-test-skips-${crypto.randomUUID()}.xml`);
	await Bun.write(path, report(testCases));
	return path;
}

describe("CI skipped-test guard", () => {
	test("accepts every explicitly gated suite", () => {
		const xml = report(
			Object.keys(EXPECTED_SKIP_FILES)
				.map((file) => skippedTest(file))
				.join(""),
		);

		expect(findUnexpectedSkips(xml)).toEqual([]);
	});

	test("rejects a skipped test outside the allowlist", () => {
		const xml = report(skippedTest("packages/esc/src/service.test.ts", "requires postgres"));

		expect(findUnexpectedSkips(xml)).toEqual([
			{ file: "packages/esc/src/service.test.ts", name: "requires postgres" },
		]);
	});

	test("does not treat passing tests as skipped", () => {
		const xml = report(
			'<testcase name="passes" file="packages/esc/src/service.test.ts"></testcase>',
		);

		expect(collectSkippedTests(xml)).toEqual([]);
	});

	test("does not pair self-closing passing cases with later skips", () => {
		const xml = report(
			'<testcase name="passes" file="e2e/cancel.test.ts" />' +
				skippedTest("e2e/oidc.test.ts", "secret-gated"),
		);

		expect(collectSkippedTests(xml)).toEqual([{ file: "e2e/oidc.test.ts", name: "secret-gated" }]);
	});

	test("parses greater-than characters inside quoted attributes", () => {
		const xml = report(
			'<testcase name="passes > threshold" file="test.ts" />' +
				skippedTest("e2e/oidc.test.ts", "secret-gated"),
		);

		expect(collectSkippedTests(xml)).toEqual([{ file: "e2e/oidc.test.ts", name: "secret-gated" }]);
	});

	test("rejects incomplete and unclosed testcase elements", () => {
		expect(() => collectSkippedTests('<testcase name="incomplete"')).toThrow(
			"Malformed JUnit XML: incomplete <testcase> tag",
		);
		expect(() => collectSkippedTests(report('<testcase name="unclosed"><skipped />'))).toThrow(
			"Malformed JUnit XML: unclosed <testcase> tag",
		);
	});

	test("removes lane-owned suites from the expected-skip allowlist", () => {
		const parsed = parseSkipGuardArguments(["--require-suite=e2e/esc-cli.test.ts", "results.xml"]);

		expect(parsed.reportPaths).toEqual(["results.xml"]);
		expect(parsed.expectedSkipFiles["e2e/esc-cli.test.ts"]).toBeUndefined();
		expect(parsed.expectedSkipFiles["e2e/oidc.test.ts"]).toBe("requires Descope credentials");
		expect(() => parseSkipGuardArguments(["--require-suite=unknown.test.ts"])).toThrow(
			"Unknown required suite: unknown.test.ts",
		);
	});

	test("requires at least one JUnit report", async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await checkTestSkips([])).toBe(2);
			expect(error).toHaveBeenCalledWith(
				"Usage: bun run scripts/check-test-skips.ts [--require-suite=<file>] <junit-report> [...]",
			);
		} finally {
			error.mockRestore();
		}
	});

	test("accepts a report without skipped tests", async () => {
		const path = await writeReport('<testcase name="passes" file="test.ts" />');
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await checkTestSkips([path])).toBe(0);
			expect(log).toHaveBeenCalledWith("Verified 1 test report(s): no skipped tests.");
		} finally {
			log.mockRestore();
			await rm(path, { force: true });
		}
	});

	test("reports allowlisted skips with their reason", async () => {
		const path = await writeReport(skippedTest("e2e/oidc.test.ts", "secret-gated"));
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await checkTestSkips([path])).toBe(0);
			expect(log).toHaveBeenCalledWith(
				"Allowed skips in e2e/oidc.test.ts: requires Descope credentials",
			);
		} finally {
			log.mockRestore();
			await rm(path, { force: true });
		}
	});

	test("fails an allowlisted skip when its owning lane requires the suite", async () => {
		const path = await writeReport(skippedTest("e2e/oidc.test.ts", "secret-gated"));
		const error = spyOn(console, "error").mockImplementation(() => {});
		const { expectedSkipFiles } = parseSkipGuardArguments(["--require-suite=e2e/oidc.test.ts"]);
		try {
			expect(await checkTestSkips([path], expectedSkipFiles)).toBe(1);
			expect(error).toHaveBeenCalledWith(
				"::error file=e2e/oidc.test.ts::Unexpected skipped test: secret-gated",
			);
		} finally {
			error.mockRestore();
			await rm(path, { force: true });
		}
	});

	test("fails a report containing an unexpected skip", async () => {
		const path = await writeReport(
			skippedTest("packages/esc/src/service.test.ts", "requires postgres"),
		);
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await checkTestSkips([path])).toBe(1);
			expect(error).toHaveBeenCalledWith(
				"::error file=packages/esc/src/service.test.ts::Unexpected skipped test: requires postgres",
			);
		} finally {
			error.mockRestore();
			await rm(path, { force: true });
		}
	});
});
