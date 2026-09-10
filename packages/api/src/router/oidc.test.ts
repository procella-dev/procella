import { describe, expect, mock, test } from "bun:test";
import type { GitHubService } from "@procella/github";
import {
	OidcPolicyClaimConditionsConflictError,
	OidcPolicyConflictError,
	OidcPolicyDisplayNameConflictError,
	type OidcTrustPolicy,
	type TrustPolicyRepository,
} from "@procella/oidc";
import type { TRPCContext } from "../trpc.js";
import { oidcRouter } from "./oidc.js";

// ============================================================================
// Mock Data
// ============================================================================

const VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

const mockPolicy: OidcTrustPolicy = {
	id: VALID_UUID,
	tenantId: "t-1",
	orgSlug: "my-org",
	provider: "github-actions",
	displayName: "CI Deploy Policy",
	issuer: "https://token.actions.githubusercontent.com",
	maxExpiration: 7200,
	claimConditions: {
		repository_owner_id: "12345",
		repository_id: "67890",
	},
	grantedRole: "member",
	active: true,
	createdAt: new Date("2025-01-01"),
	updatedAt: new Date("2025-01-01"),
};

// ============================================================================
// Mock Context
// ============================================================================

function mockPolicies(overrides?: Partial<TrustPolicyRepository>): TrustPolicyRepository {
	return {
		findByOrgSlugAndIssuer: mock(async () => [mockPolicy]),
		listByOrgSlug: mock(async () => [mockPolicy]),
		create: mock(async () => mockPolicy),
		update: mock(async () => mockPolicy),
		delete: mock(async () => {}),
		...overrides,
	};
}

function mockContext(overrides?: Partial<TRPCContext>): TRPCContext {
	return {
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-1",
			login: "admin",
			roles: ["admin"],
			principalType: "user",
		},
		resolveUserDisplayName: (subject) => Promise.resolve(subject),
		db: {} as never,
		notifications: {} as never,
		stacks: {} as never,
		audit: {} as never,
		updates: {} as never,
		webhooks: {} as never,
		esc: {} as never,
		github: null,
		oidcPolicies: mockPolicies(),
		...overrides,
	};
}

const viewerCtx = (): TRPCContext =>
	mockContext({
		caller: {
			tenantId: "t-1",
			orgSlug: "my-org",
			userId: "u-2",
			login: "viewer",
			roles: ["viewer"],
			principalType: "user",
		},
	});

const noOidcCtx = (): TRPCContext => mockContext({ oidcPolicies: null });

// ============================================================================
// Tests
// ============================================================================

describe("oidcRouter", () => {
	describe("listPolicies", () => {
		test("admin can list policies", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.listPolicies();
			expect(result).toBeArray();
			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe(VALID_UUID);
			expect(ctx.oidcPolicies?.listByOrgSlug).toHaveBeenCalledWith("my-org", "t-1");
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.listPolicies()).rejects.toThrow("Admin role required");
		});

		test("returns PRECONDITION_FAILED when OIDC disabled", () => {
			const caller = oidcRouter.createCaller(noOidcCtx());
			return expect(caller.listPolicies()).rejects.toThrow("OIDC is not enabled");
		});
	});

	describe("GitHub Actions setup", () => {
		test("reports guided setup availability and every configured GitHub Actions policy", async () => {
			await expect(oidcRouter.createCaller(noOidcCtx()).status()).resolves.toEqual({
				configured: false,
				githubActionsPolicies: [],
			});
			await expect(oidcRouter.createCaller(mockContext()).status()).resolves.toEqual({
				configured: true,
				githubActionsPolicies: [mockPolicy],
			});
		});

		test("creates a member policy from server-resolved stable repository IDs", async () => {
			const create = mock(async () => mockPolicy);
			const listInstallationRepositories = mock(async () => [
				{
					id: 67890,
					name: "infra",
					fullName: "acme/infra",
					ownerId: 12345,
					ownerLogin: "acme",
					private: true,
				},
			]);
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					findByOrgSlugAndIssuer: mock(async () => []),
					create,
				}),
				github: { listInstallationRepositories } as unknown as GitHubService,
			});

			const result = await oidcRouter.createCaller(ctx).enableGitHubActions({
				installationId: 101,
				repositoryId: 67890,
			});

			expect(result.created).toBe(true);
			expect(listInstallationRepositories).toHaveBeenCalledWith("t-1", 101);
			expect(create).toHaveBeenCalledWith({
				tenantId: "t-1",
				orgSlug: "my-org",
				provider: "github-actions",
				displayName: "GitHub Actions · acme/infra",
				issuer: "https://token.actions.githubusercontent.com",
				maxExpiration: 7200,
				claimConditions: {
					repository_owner_id: "12345",
					repository_id: "67890",
				},
				grantedRole: "member",
				active: true,
			});
		});

		test("creates another repository policy for the same tenant", async () => {
			const create = mock(async () => mockPolicy);
			const listInstallationRepositories = mock(async () => [
				{
					id: 13579,
					name: "service",
					fullName: "acme/service",
					ownerId: 12345,
					ownerLogin: "acme",
					private: true,
				},
			]);
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					findByOrgSlugAndIssuer: mock(async () => [mockPolicy]),
					create,
				}),
				github: { listInstallationRepositories } as unknown as GitHubService,
			});

			await expect(
				oidcRouter.createCaller(ctx).enableGitHubActions({
					installationId: 101,
					repositoryId: 13579,
				}),
			).resolves.toMatchObject({ created: true });
			expect(create).toHaveBeenCalledWith(
				expect.objectContaining({
					claimConditions: {
						repository_owner_id: "12345",
						repository_id: "13579",
					},
				}),
			);
		});

		test("suffixes truncated repository policy names with the stable repository ID", async () => {
			const create = mock(async () => mockPolicy);
			const fullName = `acme/${"repository-name-".repeat(8)}service`;
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					findByOrgSlugAndIssuer: mock(async () => []),
					create,
				}),
				github: {
					listInstallationRepositories: mock(async () => [
						{
							id: 13579,
							name: "service",
							fullName,
							ownerId: 12345,
							ownerLogin: "acme",
							private: true,
						},
					]),
				} as unknown as GitHubService,
			});

			await oidcRouter.createCaller(ctx).enableGitHubActions({
				installationId: 101,
				repositoryId: 13579,
			});
			expect(create).toHaveBeenCalledWith(
				expect.objectContaining({ displayName: expect.stringMatching(/ · #13579$/) }),
			);
		});

		test("rejects machine principals before policy or repository lookup", async () => {
			const findByOrgSlugAndIssuer = mock(async () => []);
			const listInstallationRepositories = mock(async () => []);
			const ctx = mockContext({
				oidcPolicies: mockPolicies({ findByOrgSlugAndIssuer }),
				github: { listInstallationRepositories } as unknown as GitHubService,
			});
			if (!ctx.caller) throw new Error("caller fixture missing");
			ctx.caller = { ...ctx.caller, principalType: "token" };

			await expect(
				oidcRouter.createCaller(ctx).enableGitHubActions({
					installationId: 101,
					repositoryId: 67890,
				}),
			).rejects.toThrow("interactive user session");
			expect(findByOrgSlugAndIssuer).not.toHaveBeenCalled();
			expect(listInstallationRepositories).not.toHaveBeenCalled();
		});

		test("returns a concurrently created tenant policy after either unique conflict", async () => {
			for (const conflict of [
				new OidcPolicyClaimConditionsConflictError(),
				new OidcPolicyDisplayNameConflictError(),
			]) {
				let lookupCount = 0;
				const findByOrgSlugAndIssuer = mock(async () => {
					lookupCount += 1;
					return lookupCount === 1 ? [] : [mockPolicy];
				});
				const create = mock(async () => {
					throw conflict;
				});
				const ctx = mockContext({
					oidcPolicies: mockPolicies({ findByOrgSlugAndIssuer, create }),
					github: {
						listInstallationRepositories: mock(async () => [
							{
								id: 67890,
								name: "infra",
								fullName: "acme/infra",
								ownerId: 12345,
								ownerLogin: "acme",
								private: true,
							},
						]),
					} as unknown as GitHubService,
				});

				await expect(
					oidcRouter.createCaller(ctx).enableGitHubActions({
						installationId: 101,
						repositoryId: 67890,
					}),
				).resolves.toEqual({ policy: mockPolicy, created: false });
				expect(findByOrgSlugAndIssuer).toHaveBeenCalledTimes(2);
			}
		});

		test("rejects a repository outside the bound installation", async () => {
			const create = mock(async () => mockPolicy);
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					findByOrgSlugAndIssuer: mock(async () => []),
					create,
				}),
				github: {
					listInstallationRepositories: mock(async () => []),
				} as unknown as GitHubService,
			});

			await expect(
				oidcRouter.createCaller(ctx).enableGitHubActions({
					installationId: 101,
					repositoryId: 67890,
				}),
			).rejects.toThrow("not available to this GitHub App installation");
			expect(create).not.toHaveBeenCalled();
		});
	});

	describe("createPolicy", () => {
		const validInput = {
			provider: "github-actions" as const,
			displayName: "CI Policy",
			issuer: "https://token.actions.githubusercontent.com",
			claimConditions: {
				repository_owner_id: "12345",
				repository_id: "67890",
			},
			grantedRole: "member" as const,
		};

		test("admin can create policy", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.createPolicy(validInput);
			expect(result.id).toBe(VALID_UUID);
			expect(ctx.oidcPolicies?.create).toHaveBeenCalledTimes(1);
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.createPolicy(validInput)).rejects.toThrow("Admin role required");
		});

		test("invalid URL in issuer is rejected", () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			return expect(caller.createPolicy({ ...validInput, issuer: "not-a-url" })).rejects.toThrow();
		});

		test("rejects issuer-only claim conditions at create", () => {
			const caller = oidcRouter.createCaller(mockContext());

			return expect(
				caller.createPolicy({
					...validInput,
					claimConditions: { iss: "https://token.actions.githubusercontent.com" },
				}),
			).rejects.toThrow("at least two claim conditions");
		});

		test("rejects wildcard sub-only claim conditions at create", () => {
			const caller = oidcRouter.createCaller(mockContext());

			return expect(
				caller.createPolicy({
					...validInput,
					claimConditions: { sub: "*" },
				}),
			).rejects.toThrow("at least two claim conditions");
		});

		test("rejects GitHub ref and environment without repository identity", () => {
			const caller = oidcRouter.createCaller(mockContext());

			return expect(
				caller.createPolicy({
					...validInput,
					claimConditions: { ref: "refs/heads/main", environment: "production" },
				}),
			).rejects.toThrow("must include a GitHub repository identity claim");
		});

		test("surfaces policy_conflict as conflict error", () => {
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					create: mock(async () => {
						throw new OidcPolicyConflictError();
					}),
				}),
			});
			const caller = oidcRouter.createCaller(ctx);

			return expect(caller.createPolicy(validInput)).rejects.toThrow(
				"OIDC trust policy with this org/issuer pair already exists",
			);
		});

		test("surfaces duplicate claim conditions as a conflict error", () => {
			const ctx = mockContext({
				oidcPolicies: mockPolicies({
					create: mock(async () => {
						throw new OidcPolicyClaimConditionsConflictError();
					}),
				}),
			});

			return expect(oidcRouter.createCaller(ctx).createPolicy(validInput)).rejects.toThrow(
				"OIDC trust policy with these claim conditions already exists",
			);
		});
	});

	describe("updatePolicy", () => {
		test("admin can update policy", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.updatePolicy({ id: VALID_UUID, displayName: "Updated Name" });
			expect(result.id).toBe(VALID_UUID);
			expect(ctx.oidcPolicies?.update).toHaveBeenCalledWith(VALID_UUID, "t-1", {
				displayName: "Updated Name",
			});
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.updatePolicy({ id: VALID_UUID, displayName: "x" })).rejects.toThrow(
				"Admin role required",
			);
		});
	});

	describe("deletePolicy", () => {
		test("admin can delete policy", async () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			const result = await caller.deletePolicy({ id: VALID_UUID });
			expect(result.success).toBe(true);
			expect(ctx.oidcPolicies?.delete).toHaveBeenCalledWith(VALID_UUID, "t-1");
		});

		test("non-admin is rejected", () => {
			const caller = oidcRouter.createCaller(viewerCtx());
			return expect(caller.deletePolicy({ id: VALID_UUID })).rejects.toThrow("Admin role required");
		});

		test("invalid UUID is rejected", () => {
			const ctx = mockContext();
			const caller = oidcRouter.createCaller(ctx);
			return expect(caller.deletePolicy({ id: "not-a-uuid" })).rejects.toThrow();
		});
	});
});
