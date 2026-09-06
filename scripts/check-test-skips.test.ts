import { describe, expect, test } from "bun:test";
import {
	collectSkippedTests,
	EXPECTED_SKIP_FILES,
	findUnexpectedSkips,
} from "./check-test-skips.ts";

function report(testCases: string): string {
	return `<testsuites><testsuite name="suite">${testCases}</testsuite></testsuites>`;
}

function skippedTest(file: string, name = "skipped test"): string {
	return `<testcase name="${name}" file="${file}"><skipped /></testcase>`;
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
});
