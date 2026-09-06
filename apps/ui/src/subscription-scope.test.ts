import { describe, expect, test } from "bun:test";
import { subscriptionScopeFromUrl } from "./subscription-scope";

function subscriptionUrl(procedure: string, input: Record<string, string>): URL {
	const url = new URL(`https://procella.dev/trpc/${procedure}`);
	url.searchParams.set("input", JSON.stringify({ json: input }));
	return url;
}

describe("subscriptionScopeFromUrl", () => {
	test("binds update event subscriptions to the update resource", () => {
		expect(
			subscriptionScopeFromUrl(
				subscriptionUrl("updates.onEvents", {
					org: "my-org",
					project: "my-project",
					stack: "dev",
					updateId: "update-1",
				}),
			),
		).toEqual({
			procedure: "updates.onEvents",
			resource: {
				org: "my-org",
				project: "my-project",
				stack: "dev",
				updateId: "update-1",
			},
		});
	});

	test("binds stack activity subscriptions without requiring an update id", () => {
		expect(
			subscriptionScopeFromUrl(
				subscriptionUrl("updates.onStackActivity", {
					org: "my-org",
					project: "my-project",
					stack: "dev",
				}),
			),
		).toEqual({
			procedure: "updates.onStackActivity",
			resource: { org: "my-org", project: "my-project", stack: "dev" },
		});
	});
});
