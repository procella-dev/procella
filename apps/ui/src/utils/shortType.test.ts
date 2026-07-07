import { describe, expect, test } from "bun:test";
import { shortType } from "./shortType";

describe("shortType", () => {
	test("strips provider prefix only when colon exists", () => {
		expect(shortType("aws:s3/bucket:Bucket")).toBe("s3/bucket:Bucket");
		expect(shortType("simpleType")).toBe("simpleType");
		expect(shortType("pulumi:pulumi:Stack")).toBe("pulumi:Stack");
	});
});
