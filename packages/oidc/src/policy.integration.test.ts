// Integration tests for PostgresTrustPolicyRepository.
// Requires a running PostgreSQL instance (uses TEST_DB_URL or default).
// Run with: bun test packages/oidc/src/policy.integration.test.ts

// Skip in unit test runs — this test requires a real PostgreSQL instance.
// Run explicitly: bun test packages/oidc/src/policy.integration.test.ts
// Or via: bun run test:integration
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type Database, oidcTrustPolicies } from "@procella/db";
import { eq, sql } from "drizzle-orm";
import { PostgresTrustPolicyRepository } from "./policy.js";

const TEST_DB_URL =
	process.env.PROCELLA_DATABASE_URL ||
	"postgres://procella:procella@localhost:5432/procella?sslmode=disable";

let db: Database;
let closeDb: () => Promise<void>;
let repo: PostgresTrustPolicyRepository;

const TENANT_ID = "integration-test-tenant";
const OTHER_TENANT_ID = "integration-test-other-tenant";
const ORG_SLUG = "integration-test-org";
const ISSUER = "https://token.actions.githubusercontent.com";

const SKIP_INTEGRATION =
	process.env.SKIP_INTEGRATION_TESTS === "true" ||
	(process.env.CI === "true" && !process.env.PROCELLA_DATABASE_URL);

const describe_db = SKIP_INTEGRATION ? describe.skip : describe;

describe_db("PostgresTrustPolicyRepository", () => {
	let createdId: string;

	beforeAll(async () => {
		const result = await createDb({ url: TEST_DB_URL, max: 2 });
		db = result.db;
		closeDb = async () => result.client.close();
		repo = new PostgresTrustPolicyRepository(db);
		await db.execute(
			sql.raw(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_oidc_trust_org_issuer_h6_test ON oidc_trust_policies (org_slug, issuer) WHERE org_slug = '${ORG_SLUG}'`,
			),
		);
		// Clean up any leftover test data
		await db.delete(oidcTrustPolicies).where(eq(oidcTrustPolicies.tenantId, TENANT_ID));
		await db.delete(oidcTrustPolicies).where(eq(oidcTrustPolicies.tenantId, OTHER_TENANT_ID));
	});

	afterAll(async () => {
		await db
			.delete(oidcTrustPolicies)
			.where(eq(oidcTrustPolicies.tenantId, TENANT_ID))
			.catch(() => {});
		await db
			.delete(oidcTrustPolicies)
			.where(eq(oidcTrustPolicies.tenantId, OTHER_TENANT_ID))
			.catch(() => {});
		await db.execute(sql`DROP INDEX IF EXISTS idx_oidc_trust_org_issuer_h6_test`).catch(() => {});
		await closeDb();
	});

	test("tenant B cannot replace tenant A policy for same org+issuer", async () => {
		const tenantAPolicy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Tenant A Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "tenant-a-org" },
			grantedRole: "member",
			active: true,
		});

		try {
			await repo.create({
				tenantId: OTHER_TENANT_ID,
				orgSlug: ORG_SLUG,
				provider: "github-actions",
				displayName: "Tenant B Policy",
				issuer: ISSUER,
				maxExpiration: 3600,
				claimConditions: { iss: ISSUER, repository_owner: "tenant-b-org" },
				grantedRole: "admin",
				active: true,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({
				code: "policy_conflict",
				message: "OIDC trust policy with this org/issuer pair already exists",
			});
		}

		const tenantAPolicies = await repo.listByOrgSlug(ORG_SLUG, TENANT_ID);
		expect(tenantAPolicies).toHaveLength(1);
		expect(tenantAPolicies[0]?.id).toBe(tenantAPolicy.id);
		expect(tenantAPolicies[0]?.displayName).toBe("Tenant A Policy");

		const tenantBPolicies = await repo.listByOrgSlug(ORG_SLUG, OTHER_TENANT_ID);
		expect(tenantBPolicies).toHaveLength(0);

		await repo.delete(tenantAPolicy.id, TENANT_ID);
	});

	test("create inserts a policy and returns it with generated id", async () => {
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Test Policy",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "member",
			active: true,
		});

		expect(policy.id).toBeString();
		expect(policy.id.length).toBeGreaterThan(0);
		expect(policy.tenantId).toBe(TENANT_ID);
		expect(policy.orgSlug).toBe(ORG_SLUG);
		expect(policy.provider).toBe("github-actions");
		expect(policy.displayName).toBe("Test Policy");
		expect(policy.issuer).toBe(ISSUER);
		expect(policy.maxExpiration).toBe(3600);
		expect(policy.claimConditions).toEqual({
			iss: ISSUER,
			repository_owner: "integration-test-org",
		});
		expect(policy.grantedRole).toBe("member");
		expect(policy.active).toBe(true);
		expect(policy.createdAt).toBeInstanceOf(Date);

		createdId = policy.id;
	});

	test("findByOrgSlug returns active policies for the org", async () => {
		const policies = await repo.findByOrgSlug(ORG_SLUG);
		expect(policies).toBeArray();
		const found = policies.find((p) => p.id === createdId);
		expect(found).toBeDefined();
		expect(found?.displayName).toBe("Test Policy");
	});

	test("findByOrgSlug does not return policies for different org", async () => {
		const policies = await repo.findByOrgSlug("some-other-org");
		const found = policies.find((p) => p.id === createdId);
		expect(found).toBeUndefined();
	});

	test("update patches allowed fields and enforces tenant isolation", async () => {
		const updated = await repo.update(createdId, TENANT_ID, {
			displayName: "Updated Policy",
			maxExpiration: 7200,
			active: false,
		});

		expect(updated.id).toBe(createdId);
		expect(updated.displayName).toBe("Updated Policy");
		expect(updated.maxExpiration).toBe(7200);
		expect(updated.active).toBe(false);
		// Unchanged fields
		expect(updated.issuer).toBe(ISSUER);
		expect(updated.claimConditions).toEqual({
			iss: ISSUER,
			repository_owner: "integration-test-org",
		});
	});

	test("findByOrgSlug excludes inactive policies", async () => {
		// Policy was set inactive in previous test
		const policies = await repo.findByOrgSlug(ORG_SLUG);
		const found = policies.find((p) => p.id === createdId);
		expect(found).toBeUndefined(); // inactive — should not appear
	});

	test("listByOrgSlug returns inactive policies too", async () => {
		// Policy is still inactive from previous test
		const all = await repo.listByOrgSlug(ORG_SLUG);
		const found = all.find((p) => p.id === createdId);
		expect(found).toBeDefined();
		expect(found?.active).toBe(false);
	});

	test("update returns error when policy not found for tenant", () => {
		return expect(
			repo.update(createdId, "wrong-tenant", { displayName: "Should Fail" }),
		).rejects.toThrow();
	});

	test("delete removes the policy", async () => {
		// Re-enable the policy first via raw update
		await repo.update(createdId, TENANT_ID, { active: true });
		await repo.delete(createdId, TENANT_ID);

		const policies = await repo.findByOrgSlug(ORG_SLUG);
		const found = policies.find((p) => p.id === createdId);
		expect(found).toBeUndefined();
	});

	test("delete is tenant-scoped (cannot delete other tenant's policy)", async () => {
		// Create a new policy to attempt deletion
		const policy = await repo.create({
			tenantId: TENANT_ID,
			orgSlug: ORG_SLUG,
			provider: "github-actions",
			displayName: "Delete Isolation Test",
			issuer: ISSUER,
			maxExpiration: 3600,
			claimConditions: { iss: ISSUER, repository_owner: "integration-test-org" },
			grantedRole: "viewer",
			active: true,
		});

		// Delete with wrong tenant — should silently not delete (no error, no rows)
		await repo.delete(policy.id, "wrong-tenant");

		// Verify still exists
		const policies = await repo.findByOrgSlug(ORG_SLUG);
		const found = policies.find((p) => p.id === policy.id);
		expect(found).toBeDefined();

		// Cleanup
		await repo.delete(policy.id, TENANT_ID);
	});
});
