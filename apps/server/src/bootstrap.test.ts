import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { requireExplicitEncryptionKey } from "./bootstrap.js";

const DEV_KEY = createHash("sha256").update("procella-dev-encryption-key").digest("hex");

describe("@procella/server bootstrap", () => {
	test("rejects missing encryption key", () => {
		expect(() => requireExplicitEncryptionKey(undefined)).toThrow(
			/PROCELLA_ENCRYPTION_KEY is required/,
		);
	});

	test("rejects the well-known dev encryption key", () => {
		expect(() => requireExplicitEncryptionKey(DEV_KEY)).toThrow(/well-known dev value/);
	});

	test("accepts explicit random encryption keys", () => {
		expect(requireExplicitEncryptionKey("a".repeat(64))).toBe("a".repeat(64));
	});

	test("rejects uppercase/mixed-case variants of the dev key (PR #149 review — case-insensitive hex compare)", () => {
		expect(() => requireExplicitEncryptionKey(DEV_KEY.toUpperCase())).toThrow(
			/well-known dev value/,
		);
		const mixed = DEV_KEY.split("")
			.map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch))
			.join("");
		expect(() => requireExplicitEncryptionKey(mixed)).toThrow(/well-known dev value/);
	});
});
