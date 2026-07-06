import { describe, expect, test } from "bun:test";
import {
	formatRelativeTime,
	getResultColor,
	shortType,
	toChangeSummary,
	toIsoOrNull,
	toUpdateStatus,
	truncateMiddle,
} from "./StackDetail.helpers";

describe("StackDetail helpers", () => {
	test("getResultColor maps known and unknown results", () => {
		expect(getResultColor("succeeded")).toBe("bg-success/10 text-success border-success/30");
		expect(getResultColor("failed")).toBe("bg-danger/10 text-danger/80 border-danger/30");
		expect(getResultColor("in-progress")).toBe(
			"bg-status-active/10 text-status-active border-status-active/30",
		);
		expect(getResultColor("cancelled")).toBe("bg-slate-brand text-cloud border-cloud/30");
		expect(getResultColor("mystery")).toBe("bg-slate-brand text-cloud border-cloud/30");
	});

	test("formatRelativeTime handles ranges and fallback date", () => {
		expect(formatRelativeTime(0)).toBe("-");

		const nowSec = Math.floor(Date.now() / 1000);
		expect(formatRelativeTime(nowSec - 30)).toBe("just now");
		expect(formatRelativeTime(nowSec - 5 * 60)).toBe("5m ago");
		expect(formatRelativeTime(nowSec - 2 * 3600)).toBe("2h ago");
		expect(formatRelativeTime(nowSec - 3 * 86400)).toBe("3d ago");

		const oldTs = nowSec - 8 * 86400;
		expect(formatRelativeTime(oldTs)).toBe(new Date(oldTs * 1000).toLocaleDateString());
	});

	test("toUpdateStatus maps result to update status", () => {
		expect(toUpdateStatus("succeeded")).toBe("succeeded");
		expect(toUpdateStatus("failed")).toBe("failed");
		expect(toUpdateStatus("cancelled")).toBe("cancelled");
		expect(toUpdateStatus("in-progress")).toBe("updating");
		expect(toUpdateStatus("unknown")).toBe("queued");
	});

	test("toIsoOrNull returns null for empty values and ISO for unix seconds", () => {
		expect(toIsoOrNull(0)).toBeNull();
		expect(toIsoOrNull(null)).toBeNull();
		expect(toIsoOrNull(undefined)).toBeNull();
		expect(toIsoOrNull(1)).toBe("1970-01-01T00:00:01.000Z");
	});

	test("toChangeSummary fills missing keys and keeps provided values", () => {
		expect(toChangeSummary({ create: 2 } as Record<string, number>)).toEqual({
			creates: 2,
			updates: 0,
			deletes: 0,
		});
		expect(toChangeSummary({ create: 1, update: 3, delete: 4 })).toEqual({
			creates: 1,
			updates: 3,
			deletes: 4,
		});
	});

	test("truncateMiddle keeps short/exact strings and truncates long strings", () => {
		expect(truncateMiddle("short", 10)).toBe("short");
		expect(truncateMiddle("exactly-ten", 11)).toBe("exactly-ten");

		const result = truncateMiddle("abcdefghijklmnopqrstuvwxyz", 10);
		expect(result.includes("…")).toBe(true);
		expect(result.startsWith("abc")).toBe(true);
		expect(result.endsWith("xyz")).toBe(true);
	});

	test("shortType strips provider prefix only when colon exists", () => {
		expect(shortType("aws:s3/bucket:Bucket")).toBe("s3/bucket:Bucket");
		expect(shortType("simpleType")).toBe("simpleType");
		expect(shortType("pulumi:pulumi:Stack")).toBe("pulumi:Stack");
	});
});
