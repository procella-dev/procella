import { execFile } from "node:child_process";
import type { DiscoveredStack, StackRef } from "./types.js";

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface ExecOptions {
	backendUrl?: string;
	token?: string;
	cwd?: string;
}

/** Spawn a pulumi CLI command with per-invocation env overrides. */
function exec(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const env: Record<string, string | undefined> = { ...process.env };
		if (opts.backendUrl) env.PULUMI_BACKEND_URL = opts.backendUrl;
		if (opts.token) env.PULUMI_ACCESS_TOKEN = opts.token;

		const child = execFile(
			"pulumi",
			["--non-interactive", ...args],
			{
				env,
				cwd: opts.cwd,
				maxBuffer: 100 * 1024 * 1024, // 100 MB for large state exports
			},
			(err, stdout, stderr) => {
				if (err && "code" in err && err.code === "ENOENT") {
					reject(
						new Error("pulumi CLI not found. Install it from https://www.pulumi.com/docs/install/"),
					);
					return;
				}
				const exitCode = err ? 1 : (child.exitCode ?? 1);
				resolve({
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					exitCode,
				});
			},
		);
	});
}

/** Parse "org/project/stack" into components. */
export function parseStackFqn(fqn: string): StackRef {
	const parts = fqn.split("/");
	if (parts.length === 3) {
		return { org: parts[0], project: parts[1], stack: parts[2] };
	}
	if (parts.length === 2) {
		return { org: "", project: parts[0], stack: parts[1] };
	}
	return { org: "", project: "", stack: fqn };
}

/** Format a StackRef back to FQN string. */
export function formatStackFqn(ref: StackRef): string {
	if (ref.org) return `${ref.org}/${ref.project}/${ref.stack}`;
	if (ref.project) return `${ref.project}/${ref.stack}`;
	return ref.stack;
}

interface PulumiStackLsEntry {
	name: string;
	current: boolean;
	lastUpdate?: string;
	updateInProgress: boolean;
	resourceCount?: number;
	url?: string;
}

/** List all stacks on a backend. Uses `pulumi stack ls --json`. */
export async function listStacks(opts: ExecOptions): Promise<DiscoveredStack[]> {
	const result = await exec(["stack", "ls", "--json", "--all"], opts);

	if (result.exitCode !== 0) {
		throw new Error(`pulumi stack ls failed (exit ${result.exitCode}): ${result.stderr}`);
	}

	const raw = result.stdout.trim();
	if (!raw || raw === "[]") return [];

	const entries: PulumiStackLsEntry[] = JSON.parse(raw);
	return entries.map((entry) => ({
		fqn: entry.name,
		ref: parseStackFqn(entry.name),
		resourceCount: entry.resourceCount ?? null,
		lastUpdate: entry.lastUpdate ?? null,
	}));
}

/** Export a stack's state to a file. Always uses --show-secrets for cross-backend safety. */
export async function exportStack(
	stackFqn: string,
	filePath: string,
	opts: ExecOptions,
): Promise<void> {
	const result = await exec(
		["stack", "export", "--show-secrets", "--stack", stackFqn, "--file", filePath],
		opts,
	);
	if (result.exitCode !== 0) {
		throw new Error(`pulumi stack export failed for ${stackFqn}: ${result.stderr}`);
	}
}

/** Check if the pulumi CLI is installed and return its version. */
export async function getVersion(): Promise<string> {
	const result = await exec(["version"]);
	if (result.exitCode !== 0) {
		throw new Error("Failed to get pulumi version");
	}
	return result.stdout.trim();
}

/** Run `pulumi preview --expect-no-changes --json` to validate a migrated stack. */
export async function previewExpectNoChanges(
	stackFqn: string,
	opts: ExecOptions,
): Promise<{ clean: boolean; summary: string }> {
	const result = await exec(
		["preview", "--expect-no-changes", "--stack", stackFqn, "--json"],
		opts,
	);
	const clean = result.exitCode === 0;
	return {
		clean,
		summary: clean ? "No changes detected" : result.stderr.slice(0, 500),
	};
}
