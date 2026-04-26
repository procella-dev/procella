import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "@procella/db";
import {
	EscEvaluationError,
	PostgresEscService,
	type EvaluatePayload,
	type EvaluateResult,
	type EvaluatorClient,
} from "@procella/esc";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getTestDb, truncateTables } from "./setup.js";

const BOOTSTRAP_PATH = resolve(import.meta.dirname ?? ".", "../.build/esc-eval/bootstrap");
const BINARY_EXISTS = existsSync(BOOTSTRAP_PATH);

const ENCRYPTION_KEY_HEX = "00".repeat(32);
const TENANT_ID = "integ-esc-tenant";
const TEST_USER = "test-user";

class StdioEvaluatorClient implements EvaluatorClient {
	private readonly binaryPath: string;

	constructor(binaryPath: string) {
		this.binaryPath = binaryPath;
	}

	async evaluate(payload: EvaluatePayload): Promise<EvaluateResult> {
		const proc = Bun.spawn([this.binaryPath], {
			env: { PROCELLA_ESC_STDIO: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
		proc.stdin.write(payloadBytes);
		proc.stdin.end();

		const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).arrayBuffer(),
		]);

		const stdout = new TextDecoder().decode(stdoutBuf);
		const stderr = new TextDecoder().decode(stderrBuf);

		if (exitCode !== 0) {
			throw new Error(`esc-eval exited ${exitCode}: ${stderr || stdout}`);
		}

		const parsed = JSON.parse(stdout) as EvaluateResult & { error?: string };

		if (parsed.error) {
			throw new Error(`evaluator error: ${parsed.error}`);
		}

		return {
			values: parsed.values ?? {},
			secrets: parsed.secrets ?? [],
			diagnostics: parsed.diagnostics ?? [],
		};
	}
}

let db: Database;
let evaluator: StdioEvaluatorClient;
let escService: PostgresEscService;

beforeAll(() => {
	db = getTestDb();
	evaluator = new StdioEvaluatorClient(BOOTSTRAP_PATH);
	escService = new PostgresEscService({
		db,
		evaluator,
		encryptionKeyHex: ENCRYPTION_KEY_HEX,
	});
});

afterEach(async () => {
	await truncateTables();
});

describe.skipIf(!BINARY_EXISTS)(
	"ESC evaluator integration (stdio mode)",
	() => {
		test("round-trip simple env: create → open session → values match", async () => {
			const yaml = "values:\n  foo: bar\n  count: 42\n";

			await escService.createEnvironment(
				TENANT_ID,
				{ projectName: "test-proj", name: "dev", yamlBody: yaml },
				TEST_USER,
			);

			const session = await escService.openSession(TENANT_ID, "test-proj", "dev");

			expect(session.sessionId).toBeTruthy();
			expect(session.values.foo).toBe("bar");
			expect(session.values.count).toBeDefined();
			expect(session.secrets).toEqual([]);

			const fetched = await escService.getSession(
				TENANT_ID,
				"test-proj",
				"dev",
				session.sessionId,
			);
			expect(fetched).not.toBeNull();
			expect(fetched!.values.foo).toBe("bar");
			expect(fetched!.sessionId).toBe(session.sessionId);
		});

		test("import resolution end-to-end: env A imports env B", async () => {
			const baseYaml = "values:\n  shared_key: from-base\n";
			const childYaml =
				"imports:\n  - test-proj/base\nvalues:\n  own_key: mine\n  ref: ${shared_key}\n";

			await escService.createEnvironment(
				TENANT_ID,
				{ projectName: "test-proj", name: "base", yamlBody: baseYaml },
				TEST_USER,
			);
			await escService.createEnvironment(
				TENANT_ID,
				{ projectName: "test-proj", name: "child", yamlBody: childYaml },
				TEST_USER,
			);

			const session = await escService.openSession(TENANT_ID, "test-proj", "child");

			expect(session.values.shared_key).toBe("from-base");
			expect(session.values.own_key).toBe("mine");
			expect(session.values.ref).toBe("from-base");
		});

		test("secret path masking: fn::secret marks paths as secret", async () => {
			const yaml = "values:\n  api_key:\n    fn::secret: abc123\n  public_val: visible\n";

			await escService.createEnvironment(
				TENANT_ID,
				{ projectName: "test-proj", name: "secrets-env", yamlBody: yaml },
				TEST_USER,
			);

			const session = await escService.openSession(TENANT_ID, "test-proj", "secrets-env");

			expect(session.secrets.length).toBeGreaterThan(0);
			const hasApiKey = session.secrets.some((p) => p.includes("api_key"));
			expect(hasApiKey).toBe(true);

			const fetched = await escService.getSession(
				TENANT_ID,
				"test-proj",
				"secrets-env",
				session.sessionId,
			);
			expect(fetched).not.toBeNull();
			const fetchedHasApiKey = fetched!.secrets.some((p) => p.includes("api_key"));
			expect(fetchedHasApiKey).toBe(true);
		});

		test("evaluator error surfaces as EscEvaluationError for unknown provider", async () => {
			const yaml =
				"values:\n  creds:\n    fn::open::aws-login:\n      region: us-east-1\n";

			await escService.createEnvironment(
				TENANT_ID,
				{ projectName: "test-proj", name: "bad-provider", yamlBody: yaml },
				TEST_USER,
			);

			try {
				await escService.openSession(TENANT_ID, "test-proj", "bad-provider");
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(EscEvaluationError);
				const evalErr = err as EscEvaluationError;
				expect(evalErr.diagnostics.length).toBeGreaterThan(0);
				expect(evalErr.diagnostics.some((d) => d.severity === "error")).toBe(true);
			}
		});

		test("StdioEvaluatorClient: direct invocation returns correct shape", async () => {
			const result = await evaluator.evaluate({
				definition: "values:\n  x: hello\n",
				imports: {},
				encryptionKeyHex: ENCRYPTION_KEY_HEX,
			});

			expect(result.values.x).toBe("hello");
			expect(Array.isArray(result.secrets)).toBe(true);
			expect(Array.isArray(result.diagnostics)).toBe(true);
		});

		test("StdioEvaluatorClient: validation error for empty definition", async () => {
			await expect(
				evaluator.evaluate({
					definition: "",
					imports: {},
					encryptionKeyHex: ENCRYPTION_KEY_HEX,
				}),
			).rejects.toThrow("definition");
		});
	},
);
