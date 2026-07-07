import { describe, expect, test } from "bun:test";
import { rolesFromClaims, tenantFromClaims } from "./claims";

describe("tenantFromClaims", () => {
	test("returns empty string for null/undefined claims", () => {
		expect(tenantFromClaims(null)).toBe("");
		expect(tenantFromClaims(undefined)).toBe("");
	});

	test("prefers the dct claim when present", () => {
		expect(tenantFromClaims({ dct: "tenant-1", tenants: { "tenant-2": {} } })).toBe("tenant-1");
	});

	test("falls back to a single tenants key when dct is absent", () => {
		expect(tenantFromClaims({ tenants: { "only-tenant": { roles: ["admin"] } } })).toBe(
			"only-tenant",
		);
	});

	test("returns empty string when multiple tenants and no dct (non-deterministic)", () => {
		expect(tenantFromClaims({ tenants: { a: {}, b: {} } })).toBe("");
	});

	test("ignores empty or non-string dct", () => {
		expect(tenantFromClaims({ dct: "" })).toBe("");
		expect(tenantFromClaims({ dct: 42 })).toBe("");
	});

	test("returns empty string when tenants is not an object", () => {
		expect(tenantFromClaims({ tenants: "nope" })).toBe("");
	});
});

describe("rolesFromClaims", () => {
	test("returns empty array for null/undefined claims", () => {
		expect(rolesFromClaims(null, "tenant-1")).toEqual([]);
		expect(rolesFromClaims(undefined, "tenant-1")).toEqual([]);
	});

	test("prefers tenant-scoped roles", () => {
		const claims = {
			roles: ["viewer"],
			tenants: { "tenant-1": { roles: ["admin", "member"] } },
		};
		expect(rolesFromClaims(claims, "tenant-1")).toEqual(["admin", "member"]);
	});

	test("falls back to top-level roles when tenant has none", () => {
		expect(rolesFromClaims({ roles: ["viewer"], tenants: {} }, "tenant-1")).toEqual(["viewer"]);
	});

	test("falls back to top-level roles when no tenantId is given", () => {
		expect(rolesFromClaims({ roles: ["member"] }, "")).toEqual(["member"]);
	});

	test("filters non-string entries out of role arrays", () => {
		const claims = { tenants: { "tenant-1": { roles: ["admin", 42, null, "viewer"] } } };
		expect(rolesFromClaims(claims, "tenant-1")).toEqual(["admin", "viewer"]);
	});

	test("returns empty array when no roles anywhere", () => {
		expect(rolesFromClaims({ tenants: { "tenant-1": {} } }, "tenant-1")).toEqual([]);
	});
});
