import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateName } from "../../packages/stacks/src/index.js";
import { apiRequest, BACKEND_URL, TEST_TOKEN } from "../helpers.js";

const repoRoot = join(import.meta.dir, "../..");
const describeSecurityE2E = process.env.PROCELLA_SECURITY_E2E === "1" ? describe : describe.skip;

function readText(relativePath: string): string {
	return readFileSync(join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
	return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

function semverTuple(version: string): [number, number, number] {
	const match = version.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error(`Invalid semver: ${version}`);
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverGte(actual: string, minimum: string): boolean {
	const [aMajor, aMinor, aPatch] = semverTuple(actual);
	const [mMajor, mMinor, mPatch] = semverTuple(minimum);

	if (aMajor !== mMajor) return aMajor > mMajor;
	if (aMinor !== mMinor) return aMinor > mMinor;
	return aPatch >= mPatch;
}

function assertCatalogVersionAtLeast(pkgName: string, minimum: string): void {
	const pkg = readJson("package.json");
	const catalog = pkg.catalog as Record<string, string> | undefined;
	const spec = catalog?.[pkgName];
	expect(typeof spec).toBe("string");
	expect(semverGte(String(spec).replace(/^[~^>=<\s]+/, ""), minimum)).toBe(true);
}

function assertDependencyVersionAtLeast(
	relativePath: string,
	depName: string,
	minimum: string,
): void {
	const pkg = readJson(relativePath);
	const dependencies = pkg.dependencies as Record<string, string> | undefined;
	const spec = dependencies?.[depName];
	expect(typeof spec).toBe("string");
	expect(semverGte(String(spec).replace(/^[~^>=<\s]+/, ""), minimum)).toBe(true);
}

describe("[security] LOW regressions (vulns.txt L1-L8)", () => {
	test("[L1] stack name regex rejects newlines/control chars", () => {
		expect(() => validateName("stack\nname", "stack")).toThrow();
		expect(() => validateName("stack\x00name", "stack")).toThrow();
		expect(() => validateName("stack\rname", "stack")).toThrow();
	});

	test("[L5] .env.example does not contain devtoken123 placeholder", () => {
		expect(readText(".env.example")).not.toMatch(/devtoken123/);
	});

	test("[L6] Caddyfile documents auto_https requirement for self-hosted", () => {
		const caddyfile = readText("apps/ui/Caddyfile");
		expect(caddyfile).toContain("auto_https off");
		expect(caddyfile).toMatch(/self-hosted deployments WITHOUT a TLS terminator/i);
	});

	test("[L7] auth log lines do not contain sub=user-1 plaintext", () => {
		const authSource = readText("packages/auth/src/index.ts");
		const logLines = authSource
			.split(/\r?\n/)
			.filter((line) => line.includes("console.warn") || line.includes("console.error"));

		expect(logLines.join("\n")).not.toMatch(/sub\s*=\s*user-1/i);
		expect(logLines.join("\n")).not.toMatch(/sub\s*=/i);
	});

	test("[L8] audit classifier regex uses NAME_SEGMENT (no unanchored greedy)", () => {
		const auditSource = readText("packages/audit/src/index.ts");
		expect(auditSource).toContain('const NAME_SEGMENT = "[a-zA-Z0-9._-]+";');
		const seg = "$" + "{NAME_SEGMENT}";
		expect(auditSource).toContain(`new RegExp(\`^/api/stacks/${seg}/${seg}/${seg}$\`)`);
	});
});

describe("[security] LIBRARY VERSION regressions (vulns.txt VL1-VL5)", () => {
	test("[VL1] drizzle-orm >= 0.45.2 (CVE-2026-39356)", () => {
		assertCatalogVersionAtLeast("drizzle-orm", "0.45.2");
	});

	test("[VL2] @trpc/server >= 11.1.1 (CVE-2025-43855)", () => {
		assertCatalogVersionAtLeast("@trpc/server", "11.1.1");
	});

	test("[VL3] hono >= 4.12.14 (CVE-2025-62610, -58362, -59139)", () => {
		assertDependencyVersionAtLeast("apps/server/package.json", "hono", "4.12.14");
		assertDependencyVersionAtLeast("packages/telemetry/package.json", "hono", "4.12.14");
	});

	test("[VL4] jose >= 6.0.0 (no JWE/JWS confusion)", () => {
		assertDependencyVersionAtLeast("packages/oidc/package.json", "jose", "6.0.0");
	});

	test("[VL5] Dockerfile.lambda does not enable AWS_LWA_PASS_THROUGH_PATH=/events", () => {
		expect(readText("Dockerfile")).not.toMatch(/AWS_LWA_PASS_THROUGH_PATH\s*=\s*\/events/);
	});
});

describeSecurityE2E("[security] HTTP regressions (vulns.txt L2-L4)", () => {
	test("[L2] HTTP responses include CSP, X-Frame-Options, HSTS headers", async () => {
		const res = await fetch(`${BACKEND_URL}/healthz`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toBeTruthy();
		expect(res.headers.get("x-frame-options")).toBeTruthy();
		expect(res.headers.get("strict-transport-security")).toContain("max-age=");
	});

	test("[L3] /api/auth/cli-token rate-limits at 11th rapid request", async () => {
		for (let attempt = 1; attempt <= 10; attempt++) {
			const res = await apiRequest("/auth/cli-token", {
				method: "POST",
				body: { name: `security-cli-${attempt}` },
			});
			expect(res.status).toBe(200);
		}

		const limited = await apiRequest("/auth/cli-token", {
			method: "POST",
			body: { name: "security-cli-11" },
		});

		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "Too many requests" });
	});

	test("[L4] X-Forwarded-For ignored when PROCELLA_TRUST_PROXY unset", async () => {
		const stack = `xff-${randomUUID().slice(0, 8)}`;
		const createRes = await fetch(`${BACKEND_URL}/api/stacks/dev-org/security/${stack}`, {
			method: "POST",
			headers: {
				Authorization: `token ${TEST_TOKEN}`,
				Accept: "application/vnd.pulumi+8",
				"Content-Type": "application/json",
				"X-Forwarded-For": "1.2.3.4",
			},
			body: "{}",
		});

		expect(createRes.status).toBe(200);

		const auditRes = await apiRequest("/orgs/dev-org/auditlogs?pageSize=20&action=stack.create");
		expect(auditRes.status).toBe(200);
		const auditBody = (await auditRes.json()) as {
			entries?: Array<{ resourceId?: string; ipAddress?: string }>;
		};
		const entry = auditBody.entries?.find((candidate) => candidate.resourceId?.includes(stack));

		expect(entry).toBeDefined();
		expect(entry?.ipAddress).not.toBe("1.2.3.4");
		expect(entry?.ipAddress).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
	});
});
