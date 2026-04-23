import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
	type EvaluatePayload,
	EvaluatorInvokeError,
	LambdaEvaluatorClient,
	UnimplementedEvaluatorClient,
} from "./evaluator-client.js";

const samplePayload: EvaluatePayload = {
	definition: "values: {a: 1}",
	imports: {},
	encryptionKeyHex: "00".repeat(32),
};

describe("UnimplementedEvaluatorClient", () => {
	test("throws descriptive error", async () => {
		const client = new UnimplementedEvaluatorClient();
		await expect(client.evaluate(samplePayload)).rejects.toMatchObject({
			message: expect.stringContaining("PROCELLA_ESC_EVALUATOR_FN_NAME"),
		});
	});

	test("error message does not leak internal configuration details", async () => {
		const client = new UnimplementedEvaluatorClient();
		await expect(client.evaluate(samplePayload)).rejects.toMatchObject({
			message: expect.not.stringContaining("keyHex"),
		});
	});
});

describe("LambdaEvaluatorClient", () => {
	let sendMock: ReturnType<typeof spyOn>;

	beforeEach(() => {
		sendMock = spyOn(LambdaClient.prototype, "send");
	});

	afterEach(() => {
		sendMock.mockRestore();
	});

	test("sends correct payload shape to Lambda", async () => {
		const expectedResult = { values: { a: 1 }, secrets: [], diagnostics: [] };
		sendMock.mockResolvedValueOnce({
			Payload: new TextEncoder().encode(JSON.stringify(expectedResult)),
		});

		const client = new LambdaEvaluatorClient({ functionName: "test-fn", region: "us-east-1" });
		await client.evaluate(samplePayload);

		expect(sendMock).toHaveBeenCalledTimes(1);
		const command = sendMock.mock.calls[0][0];
		expect(command).toBeInstanceOf(InvokeCommand);
		expect(command.input.FunctionName).toBe("test-fn");
		expect(command.input.InvocationType).toBe("RequestResponse");

		const sentPayload = JSON.parse(new TextDecoder().decode(command.input.Payload));
		expect(sentPayload).toEqual(samplePayload);
	});

	test("parses successful response correctly", async () => {
		const expectedResult = { values: { key: "val" }, secrets: ["/key"], diagnostics: [] };
		sendMock.mockResolvedValueOnce({
			Payload: new TextEncoder().encode(JSON.stringify(expectedResult)),
		});

		const client = new LambdaEvaluatorClient({ functionName: "test-fn" });
		const result = await client.evaluate(samplePayload);

		expect(result).toEqual(expectedResult);
	});

	test("throws EvaluatorInvokeError on FunctionError with remote message", async () => {
		const remoteError = JSON.stringify({ errorMessage: "panic: something broke" });
		sendMock.mockResolvedValueOnce({
			FunctionError: "Unhandled",
			Payload: new TextEncoder().encode(remoteError),
		});

		const client = new LambdaEvaluatorClient({ functionName: "test-fn" });
		await expect(client.evaluate(samplePayload)).rejects.toMatchObject({
			name: "EvaluatorInvokeError",
			message: expect.stringContaining("panic: something broke"),
		});
	});

	test("throws EvaluatorInvokeError on empty response payload", async () => {
		sendMock.mockResolvedValueOnce({});

		const client = new LambdaEvaluatorClient({ functionName: "test-fn" });
		await expect(client.evaluate(samplePayload)).rejects.toMatchObject({
			name: "EvaluatorInvokeError",
			message: expect.stringContaining("empty response"),
		});
	});

	test("wraps AWS SDK errors in EvaluatorInvokeError with cause", async () => {
		const sdkError = new Error("ThrottlingException");
		sendMock.mockRejectedValueOnce(sdkError);

		const client = new LambdaEvaluatorClient({ functionName: "test-fn" });
		let caught: unknown;
		try {
			await client.evaluate(samplePayload);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(EvaluatorInvokeError);
		const err = caught as EvaluatorInvokeError;
		expect(err.name).toBe("EvaluatorInvokeError");
		expect(err.message).toBe("ThrottlingException");
		expect(err.cause).toBe(sdkError);
	});

	test("uses configurable timeout", async () => {
		const expectedResult = { values: {}, secrets: [], diagnostics: [] };
		sendMock.mockResolvedValueOnce({
			Payload: new TextEncoder().encode(JSON.stringify(expectedResult)),
		});

		const client = new LambdaEvaluatorClient({
			functionName: "test-fn",
			timeoutMs: 10_000,
		});
		const result = await client.evaluate(samplePayload);

		expect(result).toEqual(expectedResult);
	});
});
