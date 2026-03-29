import { describe, expect, it } from "bun:test";
import { detectDanglingParents, detectOrphans, repairCheckpoint } from "./repair.js";

const r = (urn: string, parent?: string) => ({ urn, parent });

describe("detectDanglingParents", () => {
	it("finds resource with non-existent parent", () => {
		const resources = [r("urn:a"), r("urn:b", "urn:missing")];
		expect(detectDanglingParents(resources)).toEqual(["urn:b"]);
	});

	it("returns empty for clean state", () => {
		const resources = [r("urn:a"), r("urn:b", "urn:a")];
		expect(detectDanglingParents(resources)).toEqual([]);
	});
});

describe("detectOrphans", () => {
	it("detects resource unreachable from root", () => {
		const resources = [r("urn:a"), r("urn:b", "urn:a"), r("urn:c", "urn:gone")];
		expect(detectOrphans(resources)).toEqual(["urn:c"]);
	});

	it("returns empty for fully connected graph", () => {
		const resources = [r("urn:a"), r("urn:b", "urn:a"), r("urn:c", "urn:b")];
		expect(detectOrphans(resources)).toEqual([]);
	});
});

describe("repairCheckpoint", () => {
	it("removes dangling parent ref", () => {
		const resources = [r("urn:a"), r("urn:b", "urn:missing")];
		const { resources: fixed, mutations } = repairCheckpoint(resources);
		expect(fixed.find((entry) => entry.urn === "urn:b")?.parent).toBeUndefined();
		expect(mutations).toHaveLength(1);
		expect(mutations[0].type).toBe("fix-dangling-parent");
	});

	it("removes orphaned resources", () => {
		const resources = [r("urn:root"), r("urn:child", "urn:root"), r("urn:orphan", "urn:gone")];
		const { resources: fixed, mutations } = repairCheckpoint(resources);
		expect(fixed.map((entry) => entry.urn)).not.toContain("urn:orphan");
		expect(mutations.some((mutation) => mutation.type === "remove-orphan")).toBe(true);
	});

	it("is no-op on clean state", () => {
		const resources = [r("urn:a"), r("urn:b", "urn:a")];
		const { resources: fixed, mutations } = repairCheckpoint(resources);
		expect(fixed).toHaveLength(2);
		expect(mutations).toHaveLength(0);
	});
});
