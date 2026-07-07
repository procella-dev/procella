import { describe, expect, test } from "bun:test";
import {
	formatDuration,
	formatElapsed,
	formatRelative,
	mapUpdateStatus,
} from "./UpdateDetail.helpers";

describe("UpdateDetail helpers", () => {
	test("formatDuration handles undefined, small, seconds, and minutes", () => {
		expect(formatDuration(undefined)).toBe("");
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(10000)).toBe("10s");
		expect(formatDuration(60000)).toBe("1m 0s");
	});

	test("formatDuration rolls up to hours and days", () => {
		expect(formatDuration((1 * 3600 + 12 * 60) * 1000)).toBe("1h 12m");
		expect(formatDuration((2 * 86400 + 4 * 3600) * 1000)).toBe("2d 4h");
		expect(formatDuration(3600 * 1000)).toBe("1h 0m");
	});

	test("formatElapsed renders zero-padded seconds", () => {
		expect(formatElapsed(0)).toBe("0m 00s elapsed");
		expect(formatElapsed(65000)).toBe("1m 05s elapsed");
	});

	test("formatElapsed rolls up to hours and days", () => {
		expect(formatElapsed((1 * 3600 + 21 * 60) * 1000)).toBe("1h 21m elapsed");
		expect(formatElapsed((98 * 86400 + 3 * 3600) * 1000)).toBe("98d 3h elapsed");
		expect(formatElapsed(24 * 3600 * 1000)).toBe("1d 0h elapsed");
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
