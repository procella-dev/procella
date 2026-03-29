import { describe, expect, it } from "bun:test";
import { CheckpointDedup } from "./checkpoint-dedup.js";

describe("CheckpointDedup", () => {
	it("first write is never a duplicate", async () => {
		const dedup = new CheckpointDedup();
		expect(await dedup.isDuplicate("upd-1", '{"a":1}')).toBe(false);
	});

	it("identical second content is a duplicate", async () => {
		const dedup = new CheckpointDedup();
		await dedup.isDuplicate("upd-1", '{"a":1}');
		expect(await dedup.isDuplicate("upd-1", '{"a":1}')).toBe(true);
	});

	it("different content is not a duplicate", async () => {
		const dedup = new CheckpointDedup();
		await dedup.isDuplicate("upd-1", '{"a":1}');
		expect(await dedup.isDuplicate("upd-1", '{"a":2}')).toBe(false);
	});

	it("clear resets state for update", async () => {
		const dedup = new CheckpointDedup();
		await dedup.isDuplicate("upd-1", '{"a":1}');
		dedup.clear("upd-1");
		expect(await dedup.isDuplicate("upd-1", '{"a":1}')).toBe(false);
	});

	it("different updates are independent", async () => {
		const dedup = new CheckpointDedup();
		await dedup.isDuplicate("upd-1", '{"a":1}');
		expect(await dedup.isDuplicate("upd-2", '{"a":1}')).toBe(false);
	});
});
