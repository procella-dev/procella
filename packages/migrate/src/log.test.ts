import { describe, expect, test } from "bun:test";

describe("table formatting", () => {
	test("formats headers and rows with alignment", async () => {
		// Capture stdout output
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(String(chunk));
			return true;
		};

		try {
			const { table } = await import("./log.js");
			table(
				["Name", "Count"],
				[
					["alpha", "10"],
					["beta-longer", "5"],
				],
			);

			const output = chunks.join("");
			// Headers present
			expect(output).toContain("Name");
			expect(output).toContain("Count");
			// Data rows present
			expect(output).toContain("alpha");
			expect(output).toContain("beta-longer");
			expect(output).toContain("10");
			expect(output).toContain("5");
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});

describe("step formatting", () => {
	test("includes step number and message", async () => {
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(String(chunk));
			return true;
		};

		try {
			const { step } = await import("./log.js");
			step(2, 5, "Processing...");
			const output = chunks.join("");
			expect(output).toContain("[2/5]");
			expect(output).toContain("Processing...");
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});
