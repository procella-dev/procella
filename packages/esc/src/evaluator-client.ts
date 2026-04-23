// @procella/esc — EvaluatorClient: invokes the Go Lambda (esc-eval/) that
// embeds github.com/pulumi/esc to evaluate a composed environment.
//
// P0.2 scaffold: interface + placeholder implementation. Real Lambda invoke
// lands in procella-yj7.13 (P2). Recursive import resolution happens in
// packages/esc/src/service.ts BEFORE calling evaluate() — the Lambda itself
// never reads the DB or the network for imports.

/** Input for one evaluator invocation. */
export interface EvaluatePayload {
	/** YAML body of the target environment. */
	definition: string;
	/** Pre-resolved imports keyed by `{project}/{env}` — no lazy loading. */
	imports: Record<string, string>;
	/** 32-byte HKDF-derived key (hex) for decrypting envelope-wrapped values. */
	encryptionKeyHex: string;
}

export interface EvaluateDiagnostic {
	severity: "error" | "warning";
	summary: string;
	path?: string[];
}

export interface EvaluateResult {
	values: Record<string, unknown>;
	/** JSON paths marked secret by the evaluator. */
	secrets: string[];
	diagnostics: EvaluateDiagnostic[];
}

export interface EvaluatorClient {
	evaluate(payload: EvaluatePayload): Promise<EvaluateResult>;
}

/**
 * Placeholder — throws on invocation. Replaced in procella-yj7.13 with an
 * AWS Lambda invoke (`@aws-sdk/client-lambda`) for production and an
 * in-process transport for tests.
 */
export class UnimplementedEvaluatorClient implements EvaluatorClient {
	async evaluate(_: EvaluatePayload): Promise<EvaluateResult> {
		throw new Error(
			"EvaluatorClient not implemented — see procella-yj7.13 for the planned Lambda invoke implementation.",
		);
	}
}
