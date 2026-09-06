#!/usr/bin/env bun

export const EXPECTED_SKIP_FILES: Readonly<Record<string, string>> = {
	"e2e/descope-auth.test.ts": "requires deployed-preview Descope credentials",
	"e2e/oidc.test.ts": "requires Descope credentials",
	"e2e/compatibility-smoke.test.ts": "runs only in a selected compatibility lane",
	"e2e/esc-cli.test.ts": "requires the ESC CLI lane",
	"e2e/security-regressions/critical-and-high.test.ts":
		"server cases run only in the security E2E lane",
	"e2e/security-regressions/low-and-versions.test.ts": "runs only in the security E2E lane",
};

export interface SkippedTest {
	file: string;
	name: string;
}

export interface TestCaseResult extends SkippedTest {
	skipped: boolean;
}

function decodeXmlAttribute(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function readAttribute(attributes: string, name: string): string | undefined {
	const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
	return match ? decodeXmlAttribute(match[1]) : undefined;
}

export function collectTestCases(xml: string): TestCaseResult[] {
	const testCases: TestCaseResult[] = [];
	const openingTagPattern = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
	let searchFrom = 0;

	while (true) {
		const openingTagStart = xml.indexOf("<testcase", searchFrom);
		if (openingTagStart === -1) break;
		openingTagPattern.lastIndex = openingTagStart;
		const match = openingTagPattern.exec(xml);
		if (!match) {
			throw new Error(
				`Malformed JUnit XML: incomplete <testcase> tag at offset ${openingTagStart}`,
			);
		}

		searchFrom = openingTagPattern.lastIndex;
		let skipped = false;
		if (!match[0].endsWith("/>")) {
			const bodyEnd = xml.indexOf("</testcase>", searchFrom);
			if (bodyEnd === -1) {
				throw new Error(
					`Malformed JUnit XML: unclosed <testcase> tag at offset ${openingTagStart}`,
				);
			}
			const body = xml.slice(searchFrom, bodyEnd);
			searchFrom = bodyEnd + "</testcase>".length;
			skipped = /<skipped(?:\s[^>]*)?\s*\/?>/.test(body);
		}

		testCases.push({
			file: readAttribute(match[1], "file") ?? "(missing file)",
			name: readAttribute(match[1], "name") ?? "(unnamed)",
			skipped,
		});
	}

	return testCases;
}

export function collectSkippedTests(xml: string): SkippedTest[] {
	return collectTestCases(xml)
		.filter(({ skipped }) => skipped)
		.map(({ file, name }) => ({ file, name }));
}

export function findUnexpectedSkips(
	xml: string,
	expectedSkipFiles: Readonly<Record<string, string>> = EXPECTED_SKIP_FILES,
): SkippedTest[] {
	return collectSkippedTests(xml).filter(({ file }) => expectedSkipFiles[file] === undefined);
}

export interface SkipGuardArguments {
	reportPaths: string[];
	expectedSkipFiles: Record<string, string>;
	requiredSuites: string[];
	requiredTests: SkippedTest[];
}

const REQUIRE_SUITE_PREFIX = "--require-suite=";
const REQUIRE_TEST_PREFIX = "--require-test=";

export function parseSkipGuardArguments(args: string[]): SkipGuardArguments {
	const reportPaths: string[] = [];
	const expectedSkipFiles = { ...EXPECTED_SKIP_FILES };
	const requiredSuites: string[] = [];
	const requiredTests: SkippedTest[] = [];

	for (const arg of args) {
		if (arg.startsWith(REQUIRE_SUITE_PREFIX)) {
			const requiredSuite = arg.slice(REQUIRE_SUITE_PREFIX.length);
			if (!Object.hasOwn(EXPECTED_SKIP_FILES, requiredSuite)) {
				throw new Error(`Unknown required suite: ${requiredSuite || "(empty)"}`);
			}
			delete expectedSkipFiles[requiredSuite];
			requiredSuites.push(requiredSuite);
			continue;
		}

		if (arg.startsWith(REQUIRE_TEST_PREFIX)) {
			const identifier = arg.slice(REQUIRE_TEST_PREFIX.length);
			const separator = identifier.indexOf("::");
			if (separator === -1 || separator === 0 || separator + 2 === identifier.length) {
				throw new Error(`Invalid required test identifier: ${identifier || "(empty)"}`);
			}
			requiredTests.push({
				file: identifier.slice(0, separator),
				name: identifier.slice(separator + 2),
			});
			continue;
		}

		reportPaths.push(arg);
	}

	return { reportPaths, expectedSkipFiles, requiredSuites, requiredTests };
}

export async function checkTestSkips(
	reportPaths: string[],
	expectedSkipFiles: Readonly<Record<string, string>> = EXPECTED_SKIP_FILES,
	requiredSuites: readonly string[] = [],
	requiredTests: readonly SkippedTest[] = [],
): Promise<number> {
	if (reportPaths.length === 0) {
		console.error(
			"Usage: bun run scripts/check-test-skips.ts [--require-suite=<file>] [--require-test=<file>::<name>] <junit-report> [...]",
		);
		return 2;
	}

	const testCases: TestCaseResult[] = [];
	for (const reportPath of reportPaths) {
		const xml = await Bun.file(reportPath).text();
		testCases.push(...collectTestCases(xml));
	}

	const skipped = testCases.filter((test) => test.skipped);
	const executed = testCases.filter((test) => !test.skipped);
	const unexpected = skipped.filter(({ file }) => expectedSkipFiles[file] === undefined);
	const missingSuites = requiredSuites.filter(
		(requiredFile) => !executed.some(({ file }) => file === requiredFile),
	);
	const missingTests = requiredTests.filter(
		(required) =>
			!executed.some(({ file, name }) => file === required.file && name === required.name),
	);

	for (const test of unexpected) {
		console.error(`::error file=${test.file}::Unexpected skipped test: ${test.name}`);
	}
	for (const file of missingSuites) {
		console.error(`::error file=${file}::Required suite had no executed tests: ${file}`);
	}
	for (const test of missingTests) {
		console.error(`::error file=${test.file}::Required test did not execute: ${test.name}`);
	}
	if (unexpected.length > 0 || missingSuites.length > 0 || missingTests.length > 0) return 1;

	for (const file of requiredSuites) {
		console.log(`Verified required suite executed: ${file}`);
	}
	for (const test of requiredTests) {
		console.log(`Verified required test executed: ${test.file}::${test.name}`);
	}

	if (skipped.length === 0) {
		console.log(`Verified ${reportPaths.length} test report(s): no skipped tests.`);
		return 0;
	}

	for (const file of new Set(skipped.map(({ file }) => file))) {
		console.log(`Allowed skips in ${file}: ${expectedSkipFiles[file]}`);
	}
	console.log(`Verified ${skipped.length} skipped test(s) against the explicit allowlist.`);
	return 0;
}

if (import.meta.main) {
	const { reportPaths, expectedSkipFiles, requiredSuites, requiredTests } = parseSkipGuardArguments(
		process.argv.slice(2),
	);
	const exitCode = await checkTestSkips(
		reportPaths,
		expectedSkipFiles,
		requiredSuites,
		requiredTests,
	);
	if (exitCode !== 0) process.exit(exitCode);
}
