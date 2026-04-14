import { describe, expect, test } from "bun:test";
import { formatStackFqn, parseStackFqn } from "./pulumi.js";

describe("parseStackFqn", () => {
	test("parses 3-part FQN", () => {
		expect(parseStackFqn("myorg/myproject/production")).toEqual({
			org: "myorg",
			project: "myproject",
			stack: "production",
		});
	});

	test("parses 2-part name as project/stack", () => {
		expect(parseStackFqn("myproject/dev")).toEqual({
			org: "",
			project: "myproject",
			stack: "dev",
		});
	});

	test("parses single name as stack only", () => {
		expect(parseStackFqn("staging")).toEqual({
			org: "",
			project: "",
			stack: "staging",
		});
	});

	test("handles names with hyphens and dots", () => {
		expect(parseStackFqn("my-org/my.project/prod-us-east")).toEqual({
			org: "my-org",
			project: "my.project",
			stack: "prod-us-east",
		});
	});
});

describe("formatStackFqn", () => {
	test("formats 3-part ref", () => {
		expect(formatStackFqn({ org: "myorg", project: "myproject", stack: "prod" })).toBe(
			"myorg/myproject/prod",
		);
	});

	test("formats 2-part ref (no org)", () => {
		expect(formatStackFqn({ org: "", project: "myproject", stack: "dev" })).toBe("myproject/dev");
	});

	test("formats 1-part ref (stack only)", () => {
		expect(formatStackFqn({ org: "", project: "", stack: "staging" })).toBe("staging");
	});
});
