import { describe, expect, test } from "bun:test";

type UpdateStatus =
	| "succeeded"
	| "failed"
	| "updating"
	| "cancelled"
	| "queued"
	| "not-started"
	| "running";

function formatDuration(ms?: number): string {
	if (ms == null || Number.isNaN(ms)) return "";
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const mins = Math.floor(seconds / 60);
	const rem = Math.floor(seconds % 60);
	return `${mins}m ${rem}s`;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const mins = Math.floor(totalSeconds / 60);
	const secs = totalSeconds % 60;
	return `${mins}m ${secs.toString().padStart(2, "0")}s elapsed`;
}

function formatRelative(ms: number, startMs: number): string {
	const diff = Math.max(0, Math.floor((ms - startMs) / 1000));
	const mins = Math.floor(diff / 60);
	const secs = diff % 60;
	return `+${mins}:${secs.toString().padStart(2, "0")}`;
}

function mapUpdateStatus(result?: string, hasEvents?: boolean): UpdateStatus {
	if (result === "succeeded") return "succeeded";
	if (result === "failed") return "failed";
	if (result === "cancelled") return "cancelled";
	if (result === "queued") return "queued";
	if (result === "not-started") return "not-started";
	if (result === "running") return "running";
	if (result === "updating" || result === "in-progress") return "updating";
	return hasEvents ? "updating" : "not-started";
}

describe("UpdateDetail helpers", () => {
	test("formatDuration handles undefined, small, seconds, and minutes", () => {
		expect(formatDuration(undefined)).toBe("");
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(10000)).toBe("10s");
		expect(formatDuration(60000)).toBe("1m 0s");
	});

	test("formatElapsed renders zero-padded seconds", () => {
		expect(formatElapsed(0)).toBe("0m 00s elapsed");
		expect(formatElapsed(65000)).toBe("1m 05s elapsed");
	});

	test("formatRelative renders +m:ss", () => {
		expect(formatRelative(0, 0)).toBe("+0:00");
		expect(formatRelative(65000, 0)).toBe("+1:05");
	});

	test("mapUpdateStatus maps all explicit statuses", () => {
		expect(mapUpdateStatus("succeeded", false)).toBe("succeeded");
		expect(mapUpdateStatus("failed", false)).toBe("failed");
		expect(mapUpdateStatus("cancelled", false)).toBe("cancelled");
		expect(mapUpdateStatus("queued", false)).toBe("queued");
		expect(mapUpdateStatus("not-started", false)).toBe("not-started");
		expect(mapUpdateStatus("running", false)).toBe("running");
		expect(mapUpdateStatus("updating", false)).toBe("updating");
		expect(mapUpdateStatus("in-progress", false)).toBe("updating");
	});

	test("mapUpdateStatus falls back by hasEvents", () => {
		expect(mapUpdateStatus("mystery", true)).toBe("updating");
		expect(mapUpdateStatus("mystery", false)).toBe("not-started");
		expect(mapUpdateStatus(undefined, true)).toBe("updating");
		expect(mapUpdateStatus(undefined, false)).toBe("not-started");
	});
});
