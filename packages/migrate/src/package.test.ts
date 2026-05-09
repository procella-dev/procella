import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Regression guard for review feedback on PR #123:
// `node:util.parseArgs` was added in Node 18.3.0 and only became reliably
// available in the 18.x LTS line at 18.17.0. The package.json originally
// declared `engines.node: >=18.0.0`, which permits 18.0.x–18.2.x where the
// CLI would crash at startup. This test pins the minimum to a version that
// guarantees parseArgs is present so the floor cannot drift back.
describe("@procella/migrate package.json", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		engines?: { node?: string };
	};

	test("engines.node is declared", () => {
		expect(pkg.engines?.node).toBeString();
	});

	test("engines.node minimum guarantees node:util.parseArgs availability (>=18.17.0)", () => {
		const range = pkg.engines?.node ?? "";
		// We only allow `>=X.Y.Z` style ranges here. Parse the floor.
		const match = range.match(/^>=\s*(\d+)\.(\d+)\.(\d+)/);
		expect(match).not.toBeNull();
		const [, majStr, minStr, patchStr] = match as RegExpMatchArray;
		const [maj, min, patch] = [Number(majStr), Number(minStr), Number(patchStr)];

		// parseArgs landed in 18.3.0 but only became LTS-stable at 18.17.0.
		// Require >=18.17.0 OR any newer major (>=20).
		const isModern18 = maj === 18 && (min > 17 || (min === 17 && patch >= 0));
		const isNewerMajor = maj >= 19;
		expect(isModern18 || isNewerMajor).toBe(true);
	});

	// Sanity check: parseArgs really is exported from node:util in the runtime
	// executing this test (Bun + Node ≥18.17). If this import ever fails the
	// CLI's import in cli.ts would also fail.
	test("node:util exports parseArgs in the supported runtime", async () => {
		const util = await import("node:util");
		expect(typeof util.parseArgs).toBe("function");
	});
});
