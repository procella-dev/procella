import { describe, expect, test } from "bun:test";
import { parsePort } from "./parsePort";

describe("parsePort", () => {
	test("valid ports", () => {
		expect(parsePort("1024")).toBe(1024);
		expect(parsePort("8080")).toBe(8080);
		expect(parsePort("65535")).toBe(65535);
		expect(parsePort("9090")).toBe(9090);
	});

	test("null and empty", () => {
		expect(parsePort(null)).toBeNull();
		expect(parsePort("")).toBeNull();
	});

	test("rejects userinfo-syntax attack", () => {
		expect(parsePort("1234@evil.com")).toBeNull();
	});

	test("rejects trailing whitespace", () => {
		expect(parsePort("1234 ")).toBeNull();
	});

	test("rejects leading-zero octal-like", () => {
		expect(parsePort("01234")).toBeNull();
	});

	test("rejects hex notation", () => {
		expect(parsePort("0x4d2")).toBeNull();
	});

	test("rejects negative numbers", () => {
		expect(parsePort("-1")).toBeNull();
	});

	test("rejects zero", () => {
		expect(parsePort("0")).toBeNull();
	});

	test("rejects above 65535", () => {
		expect(parsePort("65536")).toBeNull();
	});

	test("rejects privileged ports", () => {
		expect(parsePort("80")).toBeNull();
		expect(parsePort("443")).toBeNull();
		expect(parsePort("1023")).toBeNull();
	});

	test("rejects floats", () => {
		expect(parsePort("1234.5")).toBeNull();
	});

	test("rejects non-numeric strings", () => {
		expect(parsePort("abc")).toBeNull();
		expect(parsePort("localhost")).toBeNull();
	});
});
