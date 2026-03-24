import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_PATH = resolve(import.meta.dir, "ProcellaLogo.tsx");
const source = readFileSync(SOURCE_PATH, "utf-8");

describe("ProcellaLogo", () => {
	test("exports ProcellaLogo as named export", () => {
		expect(source).toContain("export function ProcellaLogo");
		expect(source).toMatch(/export function ProcellaLogo\(/);
	});

	test("uses storm-petrel.svg asset, not inline SVG or text-blue-500", () => {
		expect(source).toContain("storm-petrel.svg");
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

	test("loads Storm Petrel as img element", () => {
		expect(source).toContain("storm-petrel.svg");
		expect(source).toContain("<img");
		expect(source).toContain('alt="Procella logo"');
	});
});
