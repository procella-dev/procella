import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKEND_URL, TEST_TOKEN } from "./helpers.js";

interface EscResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface EscOpts {
	cwd?: string;
	stdin?: string;
	home?: string;
}

async function resolveEscCommand(): Promise<string[] | null> {
	const direct = Bun.which("esc");
	if (direct) {
		return [direct];
	}

	const mise = Bun.which("mise");
	if (!mise) {
		return null;
	}

	const proc = Bun.spawn([mise, "which", "esc"], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return null;
	}
	const resolved = (await new Response(proc.stdout).text()).trim();
	return resolved ? [resolved] : null;
}

async function esc(args: string[], opts: EscOpts = {}): Promise<EscResult> {
	if (!ESC_COMMAND) {
		throw new Error("esc CLI is not available");
	}

	const proc = Bun.spawn([...ESC_COMMAND, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			PULUMI_ACCESS_TOKEN: TEST_TOKEN,
			PULUMI_BACKEND_URL: BACKEND_URL,
			PULUMI_HOME: opts.home ?? ESC_HOME,
			PULUMI_SKIP_UPDATE_CHECK: "true",
		},
		cwd: opts.cwd,
		stdin: opts.stdin ? new Response(opts.stdin).body : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];
	const stdoutDone = (async () => {
		for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
	})();
	const stderrDone = (async () => {
		for await (const chunk of proc.stderr) stderrChunks.push(chunk);
	})();
	const [exitCode] = await Promise.all([proc.exited, stdoutDone, stderrDone]);
	const decoder = new TextDecoder();
	return {
		stdout: stdoutChunks.map((c) => decoder.decode(c, { stream: true })).join(""),
		stderr: stderrChunks.map((c) => decoder.decode(c, { stream: true })).join(""),
		exitCode,
	};
}

function outputOf(result: EscResult): string {
	return `${result.stdout}${result.stderr}`;
}

let ESC_COMMAND: string[] | null = null;
let ESC_HOME = "";
let loginResult: EscResult;

const TEST_ORG = "dev-org";
const TEST_PROJECT = `pw-esc-${Date.now().toString(36)}`;

describe.skipIf(!(await resolveEscCommand()))("esc CLI E2E against Procella backend", () => {
	beforeAll(async () => {
		ESC_COMMAND = await resolveEscCommand();
		ESC_HOME = await mkdtemp(path.join(tmpdir(), "procella-esc-cli-"));
		loginResult = await esc(["login", BACKEND_URL]);
	});

	afterAll(async () => {
		if (ESC_HOME) {
			await rm(ESC_HOME, { recursive: true, force: true });
		}
	});

	test("esc login succeeds against Procella dev auth", async () => {
		expect(loginResult.exitCode).toBe(0);
		expect(outputOf(loginResult)).toContain("Logged in");
	});

	test("esc env init creates an environment", async () => {
		const envName = `dev1-${Date.now().toString(36)}`;
		const ref = `${TEST_ORG}/${TEST_PROJECT}/${envName}`;
		const result = await esc(["env", "init", ref]);
		expect(result.exitCode).toBe(0);
		expect(outputOf(result)).toContain(ref);
	});

	test("esc env set + env get round-trip a value", async () => {
		const envName = `dev2-${Date.now().toString(36)}`;
		const ref = `${TEST_ORG}/${TEST_PROJECT}/${envName}`;
		expect((await esc(["env", "init", ref])).exitCode).toBe(0);

		const setRes = await esc(["env", "set", ref, "greeting", "hello-procella"]);
		expect(setRes.exitCode).toBe(0);

		const getRes = await esc(["env", "get", ref, "greeting", "--value", "string"]);
		expect(getRes.exitCode).toBe(0);
		expect(getRes.stdout.trim()).toBe("hello-procella");
	});

	test("esc env ls lists environments created in the suite", async () => {
		const envName = `dev-ls-${Date.now().toString(36)}`;
		const ref = `${TEST_ORG}/${TEST_PROJECT}/${envName}`;
		expect((await esc(["env", "init", ref])).exitCode).toBe(0);

		const ls = await esc(["env", "ls", "--organization", TEST_ORG, "--project", TEST_PROJECT]);
		expect(ls.exitCode).toBe(0);
		expect(ls.stdout).toContain(`${TEST_ORG}/${TEST_PROJECT}/${envName}`);
	});

	test("esc env open returns resolved values JSON", async () => {
		const envName = `dev3-${Date.now().toString(36)}`;
		const ref = `${TEST_ORG}/${TEST_PROJECT}/${envName}`;
		expect((await esc(["env", "init", ref])).exitCode).toBe(0);
		expect((await esc(["env", "set", ref, "api_url", "https://api.example.com"])).exitCode).toBe(0);

		const open = await esc(["env", "open", ref, "--format", "json"]);
		expect(open.exitCode).toBe(0);
		const parsed = JSON.parse(open.stdout) as { api_url?: string };
		expect(parsed.api_url).toBe("https://api.example.com");
	});

	test("esc env open resolves string interpolation", async () => {
		const envName = `interp-${Date.now().toString(36)}`;
		const ref = `${TEST_ORG}/${TEST_PROJECT}/${envName}`;
		expect((await esc(["env", "init", ref])).exitCode).toBe(0);
		expect((await esc(["env", "set", ref, "host", "example.com"])).exitCode).toBe(0);
		expect(
			(await esc(["env", "set", ref, "url", "https://$" + "{host}/api", "--string"])).exitCode,
		).toBe(0);

		const open = await esc(["env", "open", ref, "--format", "json"]);
		expect(open.exitCode).toBe(0);
		const parsed = JSON.parse(open.stdout) as { url?: string };
		expect(parsed.url).toBe("https://example.com/api");
	});

	test("esc env open resolves imports composition", async () => {
		const sharedName = `shared-${Date.now().toString(36)}`;
		const consumerName = `consumer-${Date.now().toString(36)}`;
		const sharedRef = `${TEST_ORG}/${TEST_PROJECT}/${sharedName}`;
		const consumerRef = `${TEST_ORG}/${TEST_PROJECT}/${consumerName}`;

		expect((await esc(["env", "init", sharedRef])).exitCode).toBe(0);
		expect((await esc(["env", "set", sharedRef, "region", "us-east-1"])).exitCode).toBe(0);
		expect((await esc(["env", "init", consumerRef])).exitCode).toBe(0);

		const importsYaml = `imports:\n  - ${TEST_PROJECT}/${sharedName}\nvalues:\n  app_region: \${region}\n`;
		const editRes = await esc(["env", "edit", consumerRef, "--file", "-"], { stdin: importsYaml });
		expect(editRes.exitCode).toBe(0);

		const open = await esc(["env", "open", consumerRef, "--format", "json"]);
		expect(open.exitCode).toBe(0);
		const parsed = JSON.parse(open.stdout) as { app_region?: string };
		expect(parsed.app_region).toBe("us-east-1");
	});

	test("esc env rm removes an environment", async () => {
		const envName = `dev4-${Date.now().toString(36)}`;
		const ref = `${TEST_ORG}/${TEST_PROJECT}/${envName}`;
		expect((await esc(["env", "init", ref])).exitCode).toBe(0);

		const rmRes = await esc(["env", "rm", ref, "--yes"]);
		expect(rmRes.exitCode).toBe(0);

		const ls = await esc(["env", "ls", "--organization", TEST_ORG, "--project", TEST_PROJECT]);
		expect(ls.stdout).not.toContain(envName);
	});

	test("esc env init rejects malformed names", async () => {
		const result = await esc(["env", "init", `${TEST_ORG}/${TEST_PROJECT}/bad name with spaces`]);
		expect(result.exitCode).not.toBe(0);
	});

	test("esc env clone copies source YAML into destination", async () => {
		const sourceName = `src-${Date.now().toString(36)}`;
		const destName = `dst-${Date.now().toString(36)}`;
		const sourceRef = `${TEST_ORG}/${TEST_PROJECT}/${sourceName}`;
		const destRef = `${TEST_ORG}/${TEST_PROJECT}/${destName}`;

		expect((await esc(["env", "init", sourceRef])).exitCode).toBe(0);
		expect((await esc(["env", "set", sourceRef, "greeting", "cloned-value"])).exitCode).toBe(0);

		const clone = await esc(["env", "clone", sourceRef, `${TEST_PROJECT}/${destName}`]);
		expect(clone.exitCode).toBe(0);
		expect(outputOf(clone)).toContain(destRef);

		const getRes = await esc(["env", "get", destRef, "greeting", "--value", "string"]);
		expect(getRes.exitCode).toBe(0);
		expect(getRes.stdout.trim()).toBe("cloned-value");
	});
});
