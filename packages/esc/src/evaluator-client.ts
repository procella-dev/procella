// @procella/esc — EvaluatorClient: invokes the Go Lambda (esc-eval/) that
// embeds github.com/pulumi/esc to evaluate a composed environment.
//
// Two implementations:
// - UnimplementedEvaluatorClient: placeholder that throws on invocation.
// - LambdaEvaluatorClient: production client using @aws-sdk/client-lambda
//   for synchronous Lambda invoke (RequestResponse). All inputs come
//   pre-resolved in the payload — the Lambda never reads DB or network.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

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

/** Error thrown when a Lambda evaluator invocation fails. */
export class EvaluatorInvokeError extends Error {
	constructor(message: string, opts?: ErrorOptions) {
		super(message, opts);
		this.name = "EvaluatorInvokeError";
	}
}

/**
 * Placeholder — throws on invocation. Used when no evaluator Lambda is
 * configured (local dev without ESC support).
 */
export class UnimplementedEvaluatorClient implements EvaluatorClient {
	async evaluate(_: EvaluatePayload): Promise<EvaluateResult> {
		throw new Error(
			"EvaluatorClient not implemented — set PROCELLA_ESC_EVALUATOR_FN_NAME to enable ESC evaluation.",
		);
	}
}

/**
 * Production evaluator client — invokes the Go Lambda via AWS SDK.
 *
 * Uses synchronous invoke (RequestResponse) with an AbortController timeout
 * set slightly below Lambda's own 60s timeout to get a clean client-side
 * error instead of an opaque gateway timeout.
 */
export class LambdaEvaluatorClient implements EvaluatorClient {
	private readonly client: LambdaClient;
	private readonly functionName: string;
	private readonly timeoutMs: number;

	constructor(opts: { functionName: string; region?: string; timeoutMs?: number }) {
		this.functionName = opts.functionName;
		this.timeoutMs = opts.timeoutMs ?? 55_000;
		this.client = new LambdaClient({ region: opts.region ?? "us-east-1" });
	}

	async evaluate(payload: EvaluatePayload): Promise<EvaluateResult> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), this.timeoutMs);

		try {
			const response = await this.client.send(
				new InvokeCommand({
					FunctionName: this.functionName,
					InvocationType: "RequestResponse",
					Payload: new TextEncoder().encode(JSON.stringify(payload)),
				}),
				{ abortSignal: abort.signal },
			);

			if (response.FunctionError) {
				const errorText = response.Payload
					? new TextDecoder().decode(response.Payload)
					: response.FunctionError;
				throw new EvaluatorInvokeError(`Lambda evaluator error: ${errorText}`);
			}

			if (!response.Payload) {
				throw new EvaluatorInvokeError("Lambda evaluator returned empty response");
			}

			return JSON.parse(new TextDecoder().decode(response.Payload)) as EvaluateResult;
		} catch (error) {
			if (error instanceof EvaluatorInvokeError) throw error;
			throw new EvaluatorInvokeError(
				error instanceof Error ? error.message : "Unknown Lambda invoke error",
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
