import * as log from "./log.js";
import * as procella from "./procella.js";
import * as pulumi from "./pulumi.js";
import type { PreflightOptions } from "./types.js";

interface CheckResult {
	name: string;
	passed: boolean;
	detail: string;
}

export async function preflight(opts: PreflightOptions): Promise<boolean> {
	log.heading("Pre-flight checks\n");
	const checks: CheckResult[] = [];

	// 1. Pulumi CLI installed
	try {
		const version = await pulumi.getVersion();
		checks.push({ name: "Pulumi CLI", passed: true, detail: version });
	} catch {
		checks.push({ name: "Pulumi CLI", passed: false, detail: "Not found in PATH" });
	}

	// 2. Source backend reachable + authenticated
	// Only Procella has /healthz — other HTTP backends (Pulumi Cloud, etc.) don't.
	// For any source, try listing stacks via CLI as the connectivity + auth check.
	try {
		await pulumi.listStacks({ backendUrl: opts.sourceUrl, token: opts.sourceToken });
		checks.push({ name: "Source reachable", passed: true, detail: opts.sourceUrl });
		checks.push({ name: "Source auth", passed: true, detail: "Token valid" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		checks.push({ name: "Source reachable", passed: false, detail: msg });
	}

	// 3. Target backend reachable
	const targetReachable = await procella.healthCheck(opts.targetUrl);
	checks.push({
		name: "Target reachable",
		passed: targetReachable,
		detail: targetReachable ? opts.targetUrl : `Cannot reach ${opts.targetUrl}`,
	});

	// 4. Target auth
	const targetAuthed = await procella.checkAuth({ url: opts.targetUrl, token: opts.targetToken });
	checks.push({
		name: "Target auth",
		passed: targetAuthed,
		detail: targetAuthed ? "Token valid" : "Authentication failed",
	});

	// Report
	let allPassed = true;
	for (const check of checks) {
		if (check.passed) {
			log.success(`${check.name}: ${check.detail}`);
		} else {
			log.error(`${check.name}: ${check.detail}`);
			allPassed = false;
		}
	}

	if (allPassed) {
		log.info("\nAll checks passed. Ready to migrate.");
	} else {
		log.error("\nSome checks failed. Fix the issues above before migrating.");
	}

	return allPassed;
}
