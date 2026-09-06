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

export function collectSkippedTests(xml: string): SkippedTest[] {
	const skipped: SkippedTest[] = [];
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
		if (match[0].endsWith("/>")) continue;
		const bodyEnd = xml.indexOf("</testcase>", searchFrom);
		if (bodyEnd === -1) {
			throw new Error(`Malformed JUnit XML: unclosed <testcase> tag at offset ${openingTagStart}`);
		}
		const body = xml.slice(searchFrom, bodyEnd);
		searchFrom = bodyEnd + "</testcase>".length;
		if (!/<skipped(?:\s[^>]*)?\s*\/?>/.test(body)) continue;
		skipped.push({
			file: readAttribute(match[1], "file") ?? "(missing file)",
			name: readAttribute(match[1], "name") ?? "(unnamed)",
		});
	}

	return skipped;
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
}

const REQUIRE_SUITE_PREFIX = "--require-suite=";

export function parseSkipGuardArguments(args: string[]): SkipGuardArguments {
	const reportPaths: string[] = [];
	const expectedSkipFiles = { ...EXPECTED_SKIP_FILES };

	for (const arg of args) {
		if (!arg.startsWith(REQUIRE_SUITE_PREFIX)) {
			reportPaths.push(arg);
			continue;
		}

		const requiredSuite = arg.slice(REQUIRE_SUITE_PREFIX.length);
		if (!Object.hasOwn(EXPECTED_SKIP_FILES, requiredSuite)) {
			throw new Error(`Unknown required suite: ${requiredSuite || "(empty)"}`);
		}
		delete expectedSkipFiles[requiredSuite];
	}

	return { reportPaths, expectedSkipFiles };
}

export async function checkTestSkips(
	reportPaths: string[],
	expectedSkipFiles: Readonly<Record<string, string>> = EXPECTED_SKIP_FILES,
): Promise<number> {
	if (reportPaths.length === 0) {
		console.error(
			"Usage: bun run scripts/check-test-skips.ts [--require-suite=<file>] <junit-report> [...]",
		);
		return 2;
	}

	const skipped: SkippedTest[] = [];
	const unexpected: SkippedTest[] = [];
	for (const reportPath of reportPaths) {
		const xml = await Bun.file(reportPath).text();
		const reportSkips = collectSkippedTests(xml);
		skipped.push(...reportSkips);
		unexpected.push(...reportSkips.filter(({ file }) => expectedSkipFiles[file] === undefined));
	}

	if (unexpected.length > 0) {
		for (const test of unexpected) {
			console.error(`::error file=${test.file}::Unexpected skipped test: ${test.name}`);
		}
		return 1;
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
	const { reportPaths, expectedSkipFiles } = parseSkipGuardArguments(process.argv.slice(2));
	const exitCode = await checkTestSkips(reportPaths, expectedSkipFiles);
	if (exitCode !== 0) process.exit(exitCode);
}
