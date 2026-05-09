import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertSafePathSegment, assertWithin } from "./migrate.js";

// Regression tests for the path-traversal guard added after PR #123 review
// flagged that source-backend stack/project/org names may legitimately
// contain dots (Procella allows them), so a hostile or merely weird name
// like `..` could escape `opts.outputDir` when used directly as a path
// segment. These tests pin the exact attack vectors the guard rejects.

describe("assertSafePathSegment", () => {
	test("accepts ordinary names", () => {
		expect(() => assertSafePathSegment("acme", "org", "acme/api/prod")).not.toThrow();
		expect(() =>
			assertSafePathSegment("api-server", "project", "acme/api-server/prod"),
		).not.toThrow();
		expect(() => assertSafePathSegment("v1.2.3-rc1", "stack", "acme/api/v1.2.3-rc1")).not.toThrow();
	});

	test("rejects empty segment", () => {
		expect(() => assertSafePathSegment("", "org", "fqn")).toThrow(
			/empty org cannot be used as a path segment/,
		);
	});

	test("rejects exactly '.'", () => {
		expect(() => assertSafePathSegment(".", "stack", "acme/api/.")).toThrow(
			/would traverse the export directory/,
		);
	});

	test("rejects exactly '..'", () => {
		expect(() => assertSafePathSegment("..", "project", "acme/../prod")).toThrow(
			/would traverse the export directory/,
		);
	});

	test("rejects all-dots segment", () => {
		// Some filesystems treat any all-dots name as a relative-path token.
		expect(() => assertSafePathSegment("...", "stack", "fqn")).toThrow(
			/would traverse the export directory/,
		);
	});

	test("rejects forward slash in segment", () => {
		expect(() => assertSafePathSegment("a/b", "stack", "fqn")).toThrow(
			/contains path separators or null bytes/,
		);
	});

	test("rejects backslash in segment (Windows separator)", () => {
		expect(() => assertSafePathSegment("a\\b", "stack", "fqn")).toThrow(
			/contains path separators or null bytes/,
		);
	});

	test("rejects null byte injection", () => {
		expect(() => assertSafePathSegment("a\0b", "stack", "fqn")).toThrow(
			/contains path separators or null bytes/,
		);
	});
});

describe("assertWithin", () => {
	test("accepts a child directly inside parent", () => {
		expect(() =>
			assertWithin("/tmp/exports", "/tmp/exports/acme/api/prod.json", "fqn"),
		).not.toThrow();
	});

	test("accepts the parent itself (no escape)", () => {
		expect(() => assertWithin("/tmp/exports", "/tmp/exports", "fqn")).not.toThrow();
	});

	test("rejects a sibling outside parent", () => {
		expect(() => assertWithin("/tmp/exports", "/tmp/other/file.json", "fqn")).toThrow(
			/escapes outputDir/,
		);
	});

	test("rejects a path that resolves above parent via ..", () => {
		expect(() => assertWithin("/tmp/exports", "/tmp/exports/../etc/passwd", "fqn")).toThrow(
			/escapes outputDir/,
		);
	});

	test("rejects a sibling whose name shares a prefix with parent", () => {
		// e.g. parent /tmp/exp and child /tmp/exports — string-prefix match would
		// be wrong; we must compare with a trailing separator.
		expect(() => assertWithin("/tmp/exp", "/tmp/exports/file.json", "fqn")).toThrow(
			/escapes outputDir/,
		);
	});

	test("relative outputDir is normalised before comparison", () => {
		// Resolves both sides; equivalent absolute paths should be accepted.
		const cwdRelative = join("./fixtures-dir-that-need-not-exist");
		const child = join(cwdRelative, "stack.json");
		expect(() => assertWithin(cwdRelative, child, "fqn")).not.toThrow();
	});
});
