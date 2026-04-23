import { describe, expect, test } from "bun:test";
import { UnimplementedEvaluatorClient } from "./evaluator-client.js";

describe("UnimplementedEvaluatorClient", () => {
	test("throws descriptive error referencing the follow-up bead", async () => {
		const client = new UnimplementedEvaluatorClient();
		await expect(
			client.evaluate({
				definition: "values: {a: 1}",
				imports: {},
				encryptionKeyHex: "00".repeat(32),
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("procella-yj7.13"),
		});
	});

	test("error message does not leak internal configuration details", async () => {
		const client = new UnimplementedEvaluatorClient();
		await expect(
			client.evaluate({
				definition: "values: {}",
				imports: {},
				encryptionKeyHex: "00".repeat(32),
			}),
		).rejects.toMatchObject({
			message: expect.not.stringContaining("keyHex"),
		});
	});
});
