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
	const testCasePattern = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;

	for (const match of xml.matchAll(testCasePattern)) {
		if (!/<skipped(?:\s[^>]*)?\s*\/?>/.test(match[2])) continue;
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

export async function checkTestSkips(reportPaths: string[]): Promise<number> {
	if (reportPaths.length === 0) {
		console.error("Usage: bun run scripts/check-test-skips.ts <junit-report> [...]");
		return 2;
	}

	const skipped: SkippedTest[] = [];
	const unexpected: SkippedTest[] = [];
	for (const reportPath of reportPaths) {
		const xml = await Bun.file(reportPath).text();
		const reportSkips = collectSkippedTests(xml);
		skipped.push(...reportSkips);
		unexpected.push(...reportSkips.filter(({ file }) => EXPECTED_SKIP_FILES[file] === undefined));
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
		console.log(`Allowed skips in ${file}: ${EXPECTED_SKIP_FILES[file]}`);
	}
	console.log(`Verified ${skipped.length} skipped test(s) against the explicit allowlist.`);
	return 0;
}

if (import.meta.main) {
	const exitCode = await checkTestSkips(process.argv.slice(2));
	if (exitCode !== 0) process.exit(exitCode);
}
