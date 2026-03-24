import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SOURCE_PATH = resolve(import.meta.dir, "ProcellaLogo.tsx");
const source = readFileSync(SOURCE_PATH, "utf-8");

describe("ProcellaLogo", () => {
	test("exports ProcellaLogo as named export", () => {
		expect(source).toContain("export function ProcellaLogo");
		expect(source).toMatch(/export function ProcellaLogo\(/);
	});

	test("uses text-lightning for SVG icon, not text-blue-500", () => {
		expect(source).toContain("text-lightning");
		expect(source).not.toContain("text-blue-500");
	});

	test("uses text-mist for brand text, not text-zinc-100", () => {
		expect(source).toContain("text-mist");
		expect(source).not.toContain("text-zinc-100");
	});

	test("size='sm' produces w-5 h-5 icon dimensions", () => {
		expect(source).toContain('sm: { icon: "w-5 h-5"');
	});

	test("linkTo prop wraps content in Link component", () => {
		expect(source).toContain("import { Link }");
		expect(source).toContain("if (linkTo)");
		expect(source).toContain("<Link to={linkTo}");
	});

	test("contains Storm Petrel SVG elements", () => {
		expect(source).toContain("Storm Petrel");
		expect(source).toContain('viewBox="0 0 24 24"');
		expect(source).toContain('fill="#FFB800"'); // Flash amber eye
		expect(source).toContain("currentColor"); // Body uses currentColor
	});
});
