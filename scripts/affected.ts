#!/usr/bin/env bun
// Dependency-aware change detection for the monorepo.
// Builds the workspace dependency graph from package.json files, diffs changed
// files against a base ref, walks dependents transitively, and maps the result
// to deploy targets (server, ui, docs, infra).
//
// Usage:
//   bun run scripts/affected.ts                  # auto-detect base (CI or local)
//   bun run scripts/affected.ts --base=main      # explicit base ref
//   bun run scripts/affected.ts --files=a.ts,b.ts # skip git, use these files

export {};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AffectedResult {
	/** Whether the server Vercel function needs redeploying */
	server: boolean;
	/** Whether the UI static site needs rebuilding */
	ui: boolean;
	/** Whether the docs site needs redeploying */
	docs: boolean;
	/** Whether Pulumi infra needs running */
	infra: boolean;
	/** Whether database migrations may be needed */
	migrate: boolean;
	/** List of affected workspace package names */
	affected: string[];
}

// ---------------------------------------------------------------------------
// Graph builder — reads package.json workspace deps
// ---------------------------------------------------------------------------

/** Map from package name → directory path relative to repo root */
type PackageMap = Map<string, string>;
/** Map from package name → set of package names it depends on */
type DepGraph = Map<string, Set<string>>;

async function buildGraph(): Promise<{ packages: PackageMap; deps: DepGraph }> {
	const { readdir } = await import("node:fs/promises");
	const packages: PackageMap = new Map();
	const deps: DepGraph = new Map();

	const dirs = [
		...(await readdir("packages", { withFileTypes: true }))
			.filter((d) => d.isDirectory())
			.map((d) => `packages/${d.name}`),
		...(await readdir("apps", { withFileTypes: true }))
			.filter((d) => d.isDirectory())
			.map((d) => `apps/${d.name}`),
	];

	for (const dir of dirs) {
		try {
			const pkg = await Bun.file(`${dir}/package.json`).json();
			const name: string = pkg.name;
			if (!name) continue;
			packages.set(name, dir);
			const workspaceDeps = new Set<string>();
			for (const section of ["dependencies", "devDependencies"] as const) {
				for (const [dep, ver] of Object.entries(
					(pkg[section] as Record<string, string>) ?? {},
				)) {
					if (typeof ver === "string" && ver.startsWith("workspace:")) {
						workspaceDeps.add(dep);
					}
				}
			}
			deps.set(name, workspaceDeps);
		} catch {
			// skip dirs without package.json
		}
	}

	return { packages, deps };
}

// ---------------------------------------------------------------------------
// Reverse graph — who depends on a given package (direct dependents)
// ---------------------------------------------------------------------------

function buildReverseGraph(deps: DepGraph): Map<string, Set<string>> {
	const reverse = new Map<string, Set<string>>();
	for (const name of deps.keys()) {
		reverse.set(name, new Set());
	}
	for (const [name, pkgDeps] of deps) {
		for (const dep of pkgDeps) {
			if (!reverse.has(dep)) reverse.set(dep, new Set());
			reverse.get(dep)!.add(name);
		}
	}
	return reverse;
}

// ---------------------------------------------------------------------------
// Transitive walk — given a set of directly-changed packages, find all affected
// ---------------------------------------------------------------------------

export function walkAffected(
	changed: Set<string>,
	reverseGraph: Map<string, Set<string>>,
): Set<string> {
	const affected = new Set<string>();
	const queue = [...changed];
	while (queue.length > 0) {
		const pkg = queue.pop()!;
		if (affected.has(pkg)) continue;
		affected.add(pkg);
		for (const dependent of reverseGraph.get(pkg) ?? []) {
			if (!affected.has(dependent)) queue.push(dependent);
		}
	}
	return affected;
}

// ---------------------------------------------------------------------------
// Git diff — get changed files between base and HEAD
// ---------------------------------------------------------------------------

async function getChangedFiles(baseRef?: string): Promise<string[]> {
	// Determine base ref: explicit flag > CI env > merge-base with main
	const base =
		baseRef ??
		process.env.GITHUB_BASE_REF ?? // PR target branch in GitHub Actions
		undefined;

	let cmd: string[];
	if (base) {
		// Use merge-base for accurate diff (handles diverged branches)
		const mergeBase = Bun.spawnSync(["git", "merge-base", base, "HEAD"], {
			stdout: "pipe",
		});
		const mb = mergeBase.stdout.toString().trim();
		cmd = ["git", "diff", "--name-only", mb || base, "HEAD"];
	} else {
		// Fallback: diff against HEAD~1 (push to main)
		cmd = ["git", "diff", "--name-only", "HEAD~1", "HEAD"];
	}

	const result = Bun.spawnSync(cmd, { stdout: "pipe" });
	return result.stdout
		.toString()
		.trim()
		.split("\n")
		.filter((f) => f.length > 0);
}

// ---------------------------------------------------------------------------
// File → package mapping
// ---------------------------------------------------------------------------

function fileToPackage(
	filePath: string,
	packages: PackageMap,
): string | null {
	for (const [name, dir] of packages) {
		if (filePath.startsWith(`${dir}/`)) return name;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Target mapping — which deploy targets are affected
// ---------------------------------------------------------------------------

/** Files outside any package that affect all app targets */
const GLOBAL_APP_PATTERNS = [
	"bun.lock",
	"package.json",
	"tsconfig.json",
	"scripts/build-vercel.sh",
	"scripts/migrate.ts",
];

export function computeTargets(
	affected: Set<string>,
	changedFiles: string[],
	packages: PackageMap,
): AffectedResult {
	const result: AffectedResult = {
		server: false,
		ui: false,
		docs: false,
		infra: false,
		migrate: false,
		affected: [...affected].sort(),
	};

	// Check for global files that affect all app targets
	for (const file of changedFiles) {
		if (GLOBAL_APP_PATTERNS.includes(file)) {
			result.server = true;
			result.ui = true;
			result.migrate = true;
			break;
		}
	}

	// Check for infra changes (outside workspace packages)
	for (const file of changedFiles) {
		if (file.startsWith("infra/")) {
			result.infra = true;
			break;
		}
	}

	// Map affected packages to deploy targets
	for (const pkg of affected) {
		const dir = packages.get(pkg);
		if (!dir) continue;

		if (dir === "apps/docs") {
			result.docs = true;
		} else if (dir === "apps/ui") {
			result.ui = true;
		} else if (dir === "apps/server") {
			result.server = true;
		} else if (dir.startsWith("packages/")) {
			// Any shared package change affects server (it consumes everything).
			// UI is only affected if api or types changed (its only workspace deps).
			result.server = true;
			if (pkg === "@procella/api" || pkg === "@procella/types") {
				result.ui = true;
			}
		}
	}

	// DB schema changes need migrations
	if (affected.has("@procella/db")) {
		result.migrate = true;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const baseFlag = args.find((a) => a.startsWith("--base="))?.split("=")[1];
	const filesFlag = args.find((a) => a.startsWith("--files="))?.split("=")[1];

	const { packages, deps } = await buildGraph();
	const reverseGraph = buildReverseGraph(deps);

	// Get changed files
	const changedFiles = filesFlag
		? filesFlag.split(",")
		: await getChangedFiles(baseFlag);

	// Map files to directly-changed packages
	const directlyChanged = new Set<string>();
	for (const file of changedFiles) {
		const pkg = fileToPackage(file, packages);
		if (pkg) directlyChanged.add(pkg);
	}

	// Walk dependents transitively
	const affected = walkAffected(directlyChanged, reverseGraph);

	// Compute deploy targets
	const result = computeTargets(affected, changedFiles, packages);

	console.log(JSON.stringify(result));
}

if (import.meta.main) await main();
