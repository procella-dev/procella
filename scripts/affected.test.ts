import { describe, expect, test } from "bun:test";
import { computeTargets, walkAffected } from "./affected.ts";

// ---------------------------------------------------------------------------
// Test graph matching the real Procella dependency structure
// ---------------------------------------------------------------------------

/** Reverse graph: package → set of packages that depend on it */
function buildTestReverseGraph(): Map<string, Set<string>> {
	const reverse = new Map<string, Set<string>>();

	// types is depended on by: config, crypto, auth, stacks, updates, api, server, ui
	reverse.set(
		"@procella/types",
		new Set([
			"@procella/config",
			"@procella/crypto",
			"@procella/auth",
			"@procella/stacks",
			"@procella/updates",
			"@procella/api",
			"@procella/server",
			"@procella/ui",
		]),
	);
	// config is depended on by: db, crypto, storage, auth, server
	reverse.set(
		"@procella/config",
		new Set([
			"@procella/db",
			"@procella/crypto",
			"@procella/storage",
			"@procella/auth",
			"@procella/server",
		]),
	);
	// db is depended on by: stacks, updates, api, server
	reverse.set(
		"@procella/db",
		new Set(["@procella/stacks", "@procella/updates", "@procella/api", "@procella/server"]),
	);
	// crypto is depended on by: updates, server
	reverse.set("@procella/crypto", new Set(["@procella/updates", "@procella/server"]));
	// storage is depended on by: updates, server
	reverse.set("@procella/storage", new Set(["@procella/updates", "@procella/server"]));
	// auth is depended on by: server
	reverse.set("@procella/auth", new Set(["@procella/server"]));
	// stacks is depended on by: api, server
	reverse.set("@procella/stacks", new Set(["@procella/api", "@procella/server"]));
	// updates is depended on by: api, server
	reverse.set("@procella/updates", new Set(["@procella/api", "@procella/server"]));
	// api is depended on by: server, ui
	reverse.set("@procella/api", new Set(["@procella/server", "@procella/ui"]));
	// leaves: no dependents
	reverse.set("@procella/server", new Set());
	reverse.set("@procella/ui", new Set());
	reverse.set("@procella/docs", new Set());

	return reverse;
}

/** Package name → directory path */
function buildTestPackages(): Map<string, string> {
	return new Map([
		["@procella/types", "packages/types"],
		["@procella/config", "packages/config"],
		["@procella/db", "packages/db"],
		["@procella/crypto", "packages/crypto"],
		["@procella/storage", "packages/storage"],
		["@procella/auth", "packages/auth"],
		["@procella/stacks", "packages/stacks"],
		["@procella/updates", "packages/updates"],
		["@procella/api", "packages/api"],
		["@procella/server", "apps/server"],
		["@procella/ui", "apps/ui"],
		["@procella/docs", "apps/docs"],
	]);
}

// ---------------------------------------------------------------------------
// walkAffected
// ---------------------------------------------------------------------------

describe("walkAffected", () => {
	const reverse = buildTestReverseGraph();

	test("leaf change affects only itself", () => {
		const affected = walkAffected(new Set(["@procella/server"]), reverse);
		expect(affected).toEqual(new Set(["@procella/server"]));
	});

	test("docs change is isolated", () => {
		const affected = walkAffected(new Set(["@procella/docs"]), reverse);
		expect(affected).toEqual(new Set(["@procella/docs"]));
	});

	test("auth change affects auth + server", () => {
		const affected = walkAffected(new Set(["@procella/auth"]), reverse);
		expect(affected).toEqual(new Set(["@procella/auth", "@procella/server"]));
	});

	test("api change affects api + server + ui", () => {
		const affected = walkAffected(new Set(["@procella/api"]), reverse);
		expect(affected).toEqual(new Set(["@procella/api", "@procella/server", "@procella/ui"]));
	});

	test("db change cascades through stacks, updates, api to server + ui", () => {
		const affected = walkAffected(new Set(["@procella/db"]), reverse);
		expect(affected).toEqual(
			new Set([
				"@procella/db",
				"@procella/stacks",
				"@procella/updates",
				"@procella/api",
				"@procella/server",
				"@procella/ui",
			]),
		);
	});

	test("types change affects everything except docs", () => {
		const affected = walkAffected(new Set(["@procella/types"]), reverse);
		const allExceptDocs = new Set([
			"@procella/types",
			"@procella/config",
			"@procella/db",
			"@procella/crypto",
			"@procella/storage",
			"@procella/auth",
			"@procella/stacks",
			"@procella/updates",
			"@procella/api",
			"@procella/server",
			"@procella/ui",
		]);
		expect(affected).toEqual(allExceptDocs);
	});

	test("multiple direct changes merge correctly", () => {
		const affected = walkAffected(new Set(["@procella/auth", "@procella/docs"]), reverse);
		expect(affected).toEqual(new Set(["@procella/auth", "@procella/server", "@procella/docs"]));
	});

	test("empty input returns empty set", () => {
		const affected = walkAffected(new Set(), reverse);
		expect(affected).toEqual(new Set());
	});
});

// ---------------------------------------------------------------------------
// computeTargets
// ---------------------------------------------------------------------------

describe("computeTargets", () => {
	const packages = buildTestPackages();

	test("server-only change: auth file", () => {
		const affected = new Set(["@procella/auth", "@procella/server"]);
		const result = computeTargets(affected, ["packages/auth/src/descope.ts"], packages);

		expect(result.server).toBe(true);
		expect(result.ui).toBe(false);
		expect(result.docs).toBe(false);
		expect(result.infra).toBe(false);
	});

	test("ui-only change: ui component", () => {
		const affected = new Set(["@procella/ui"]);
		const result = computeTargets(affected, ["apps/ui/src/pages/Settings.tsx"], packages);

		expect(result.server).toBe(false);
		expect(result.ui).toBe(true);
		expect(result.docs).toBe(false);
		expect(result.infra).toBe(false);
	});

	test("api change affects both server and ui", () => {
		const affected = new Set(["@procella/api", "@procella/server", "@procella/ui"]);
		const result = computeTargets(affected, ["packages/api/src/router/stacks.ts"], packages);

		expect(result.server).toBe(true);
		expect(result.ui).toBe(true);
		expect(result.docs).toBe(false);
	});

	test("types change affects server + ui", () => {
		const allExceptDocs = new Set([
			"@procella/types",
			"@procella/config",
			"@procella/db",
			"@procella/crypto",
			"@procella/storage",
			"@procella/auth",
			"@procella/stacks",
			"@procella/updates",
			"@procella/api",
			"@procella/server",
			"@procella/ui",
		]);
		const result = computeTargets(allExceptDocs, ["packages/types/src/domain.ts"], packages);

		expect(result.server).toBe(true);
		expect(result.ui).toBe(true);
		expect(result.docs).toBe(false);
	});

	test("docs change only affects docs", () => {
		const affected = new Set(["@procella/docs"]);
		const result = computeTargets(affected, ["apps/docs/src/content/intro.md"], packages);

		expect(result.server).toBe(false);
		expect(result.ui).toBe(false);
		expect(result.docs).toBe(true);
		expect(result.infra).toBe(false);
	});

	test("infra change detected from file path", () => {
		const affected = new Set<string>();
		const result = computeTargets(affected, ["infra/index.ts"], packages);

		expect(result.infra).toBe(true);
		expect(result.server).toBe(false);
	});

	test("bun.lock triggers all app targets", () => {
		const affected = new Set<string>();
		const result = computeTargets(affected, ["bun.lock"], packages);

		expect(result.server).toBe(true);
		expect(result.ui).toBe(true);
		expect(result.migrate).toBe(true);
		expect(result.docs).toBe(true);
		expect(result.infra).toBe(false);
	});

	test("root package.json triggers all app targets", () => {
		const affected = new Set<string>();
		const result = computeTargets(affected, ["package.json"], packages);

		expect(result.server).toBe(true);
		expect(result.ui).toBe(true);
		expect(result.migrate).toBe(true);
		expect(result.docs).toBe(true);
	});

	test("db change sets migrate flag", () => {
		const affected = new Set([
			"@procella/db",
			"@procella/stacks",
			"@procella/updates",
			"@procella/api",
			"@procella/server",
			"@procella/ui",
		]);
		const result = computeTargets(affected, ["packages/db/src/schema.ts"], packages);

		expect(result.migrate).toBe(true);
		expect(result.server).toBe(true);
	});

	test("root README does not trigger any target", () => {
		const affected = new Set<string>();
		const result = computeTargets(affected, ["README.md"], packages);

		expect(result.server).toBe(false);
		expect(result.ui).toBe(false);
		expect(result.docs).toBe(false);
		expect(result.infra).toBe(false);
		expect(result.migrate).toBe(false);
	});

	test("affected array is sorted", () => {
		const affected = new Set(["@procella/ui", "@procella/api", "@procella/server"]);
		const result = computeTargets(affected, ["packages/api/src/index.ts"], packages);

		expect(result.affected).toEqual(["@procella/api", "@procella/server", "@procella/ui"]);
	});
});
