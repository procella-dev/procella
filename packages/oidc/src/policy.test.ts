import { describe, expect, test } from "bun:test";
import { Role } from "@procella/types";
import { findMatchingPolicy, matchPolicy } from "./policy.js";
import type { OidcTrustPolicy } from "./types.js";

function makePolicy(
	claimConditions: Record<string, string>,
	overrides: Partial<OidcTrustPolicy> = {},
): OidcTrustPolicy {
	return {
		id: "policy-1",
		tenantId: "tenant-1",
		orgSlug: "acme",
		provider: "github-actions",
		displayName: "default-policy",
		issuer: "https://token.actions.githubusercontent.com",
		maxExpiration: 3600,
		claimConditions,
		grantedRole: Role.Member,
		active: true,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

describe("matchPolicy", () => {
	test("all conditions match", () => {
		const policy = makePolicy({ repository: "acme/procella", ref: "refs/heads/main" });
		const claims = { repository: "acme/procella", ref: "refs/heads/main" };

		expect(matchPolicy(policy, claims)).toBe(true);
	});

	test("one condition mismatches", () => {
		const policy = makePolicy({ repository: "acme/procella", ref: "refs/heads/main" });
		const claims = { repository: "acme/procella", ref: "refs/heads/dev" };

		expect(matchPolicy(policy, claims)).toBe(false);
	});

	test("extra jwt claims still matches when required subset matches", () => {
		const policy = makePolicy({
			iss: "https://token.actions.githubusercontent.com",
			sub: "repo:acme/procella:ref:refs/heads/main",
		});
		const claims = {
			iss: "https://token.actions.githubusercontent.com",
			sub: "repo:acme/procella:ref:refs/heads/main",
			aud: "procella",
			iat: 1715000000,
		};

		expect(matchPolicy(policy, claims)).toBe(true);
	});

	test("empty conditions rejects all jwt claim sets", () => {
		const policy = makePolicy({});

		expect(matchPolicy(policy, {})).toBe(false);
		expect(matchPolicy(policy, { any: "value", n: 1 })).toBe(false);
	});

	test("rejects broad issuer-only policy", () => {
		const policy = makePolicy({ iss: "https://token.actions.githubusercontent.com" });

		expect(
			matchPolicy(policy, {
				iss: "https://token.actions.githubusercontent.com",
				repository_owner: "myorg",
			}),
		).toBe(false);
	});

	test("rejects wildcard sub-only policy", () => {
		const policy = makePolicy({ sub: "*" });

		expect(matchPolicy(policy, { sub: "*" })).toBe(false);
	});

	test("accepts iss plus specific sub policy", () => {
		const policy = makePolicy({
			iss: "https://token.actions.githubusercontent.com",
			sub: "repo:org/repo:ref:refs/heads/main",
		});

		expect(
			matchPolicy(policy, {
				iss: "https://token.actions.githubusercontent.com",
				sub: "repo:org/repo:ref:refs/heads/main",
			}),
		).toBe(true);
	});

	test("accepts iss plus repository_owner policy", () => {
		const policy = makePolicy({
			iss: "https://token.actions.githubusercontent.com",
			repository_owner: "myorg",
		});

		expect(
			matchPolicy(policy, {
				iss: "https://token.actions.githubusercontent.com",
				repository_owner: "myorg",
			}),
		).toBe(true);
	});

	test("missing claim in jwt does not match", () => {
		const policy = makePolicy({ repository: "acme/procella", environment: "prod" });
		const claims = { repository: "acme/procella" };

		expect(matchPolicy(policy, claims)).toBe(false);
	});

	test("github actions realistic claim set matches with string coercion", () => {
		const policy = makePolicy({
			repository: "acme/procella",
			repository_id: "123456789",
			ref: "refs/heads/main",
			workflow_ref: "acme/procella/.github/workflows/deploy.yml@refs/heads/main",
		});
		const claims = {
			iss: "https://token.actions.githubusercontent.com",
			aud: "procella",
			sub: "repo:acme/procella:ref:refs/heads/main",
			repository: "acme/procella",
			repository_id: 123456789,
			ref: "refs/heads/main",
			workflow_ref: "acme/procella/.github/workflows/deploy.yml@refs/heads/main",
		};

		expect(matchPolicy(policy, claims)).toBe(true);
	});
});

describe("findMatchingPolicy", () => {
	test("returns first matching policy from multiple policies", () => {
		const policies: OidcTrustPolicy[] = [
			makePolicy(
				{ iss: "https://token.actions.githubusercontent.com", repository: "acme/other" },
				{ id: "p1", displayName: "no-match" },
			),
			makePolicy(
				{
					iss: "https://token.actions.githubusercontent.com",
					repository: "acme/procella",
					ref: "refs/heads/main",
				},
				{ id: "p2", displayName: "first-match" },
			),
			makePolicy(
				{ iss: "https://token.actions.githubusercontent.com", repository: "acme/procella" },
				{ id: "p3", displayName: "second-match" },
			),
		];

		const found = findMatchingPolicy(policies, {
			iss: "https://token.actions.githubusercontent.com",
			repository: "acme/procella",
			ref: "refs/heads/main",
		});

		expect(found?.id).toBe("p2");
	});

	test("returns null when no policy matches", () => {
		const policies: OidcTrustPolicy[] = [
			makePolicy(
				{ iss: "https://token.actions.githubusercontent.com", repository: "acme/one" },
				{ id: "p1" },
			),
			makePolicy(
				{
					iss: "https://token.actions.githubusercontent.com",
					repository: "acme/two",
					ref: "refs/heads/main",
				},
				{ id: "p2" },
			),
		];

		const found = findMatchingPolicy(policies, {
			iss: "https://token.actions.githubusercontent.com",
			repository: "acme/procella",
			ref: "refs/heads/dev",
		});

		expect(found).toBeNull();
	});
});
