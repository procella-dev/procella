import { describe, expect, test } from "bun:test";

type UpdateStatus =
	| "succeeded"
	| "failed"
	| "updating"
	| "cancelled"
	| "queued"
	| "not-started"
	| "running";

function getResultColor(result: string) {
	switch (result) {
		case "succeeded":
			return "bg-green-900/30 text-green-400 border-green-900/50";
		case "failed":
			return "bg-red-900/30 text-red-400 border-red-900/50";
		case "in-progress":
			return "bg-yellow-900/30 text-yellow-400 border-yellow-900/50";
		case "cancelled":
			return "bg-slate-brand text-cloud border-cloud/30";
		default:
			return "bg-slate-brand text-cloud border-cloud/30";
	}
}

function formatRelativeTime(timestamp: number) {
	if (!timestamp) return "-";
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
	return new Date(timestamp * 1000).toLocaleDateString();
}

function toUpdateStatus(result: string): UpdateStatus {
	switch (result) {
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "in-progress":
			return "updating";
		default:
			return "queued";
	}
}

function toIsoOrNull(timestamp?: number | null): string | null {
	if (!timestamp) return null;
	return new Date(timestamp * 1000).toISOString();
}

function toChangeSummary(resourceChanges: Record<string, number>) {
	return {
		creates: resourceChanges.create ?? 0,
		updates: resourceChanges.update ?? 0,
		deletes: resourceChanges.delete ?? 0,
	};
}

function truncateMiddle(str: string, maxLen: number) {
	if (str.length <= maxLen) return str;
	const half = Math.floor((maxLen - 3) / 2);
	return `${str.slice(0, half)}…${str.slice(-half)}`;
}

function shortType(type: string) {
	const colonIdx = type.indexOf(":");
	if (colonIdx === -1) return type;
	return type.slice(colonIdx + 1);
}

describe("StackDetail helpers", () => {
	test("getResultColor maps known and unknown results", () => {
		expect(getResultColor("succeeded")).toBe("bg-green-900/30 text-green-400 border-green-900/50");
		expect(getResultColor("failed")).toBe("bg-red-900/30 text-red-400 border-red-900/50");
		expect(getResultColor("in-progress")).toBe(
			"bg-yellow-900/30 text-yellow-400 border-yellow-900/50",
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
