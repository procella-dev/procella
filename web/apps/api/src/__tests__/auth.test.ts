import { describe, expect, it } from "bun:test";
import { TRPCError } from "@trpc/server";
import { authenticate } from "../auth.js";

// These tests run in dev mode (STRATA_AUTH_MODE defaults to "dev")
// The env module reads STRATA_DEV_AUTH_TOKEN at import time.
// We set it before the auth module loads via env.ts.

describe("authenticate (dev mode)", () => {
	it("authenticates with valid dev token", () => {
		const token = process.env.STRATA_DEV_AUTH_TOKEN;
		if (!token) {
			// If no dev token is set, skip (test env may not have it)
			return;
		}

		const result = authenticate(`token ${token}`);
		// Dev mode returns synchronously
		expect(result).toEqual(
			expect.objectContaining({
				userId: "dev-user-id",
				role: "admin",
			}),
		);
	});

	it("throws UNAUTHORIZED for missing Authorization header", () => {
		expect(() => authenticate(undefined)).toThrow(TRPCError);
		try {
			authenticate(undefined);
		} catch (err) {
			expect(err).toBeInstanceOf(TRPCError);
			expect((err as TRPCError).code).toBe("UNAUTHORIZED");
		}
	});

	it("throws UNAUTHORIZED for empty Authorization header", () => {
		expect(() => authenticate("")).toThrow(TRPCError);
	});

	it("throws UNAUTHORIZED for malformed Authorization header", () => {
		expect(() => authenticate("Bearer some-jwt")).toThrow(TRPCError);
		expect(() => authenticate("Basic dXNlcjpwYXNz")).toThrow(TRPCError);
		expect(() => authenticate("garbage")).toThrow(TRPCError);
	});

	it("throws UNAUTHORIZED for invalid token value", () => {
		expect(() => authenticate("token wrong-token-value")).toThrow(TRPCError);
	});
});
