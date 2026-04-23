import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDb, escProjects } from "@procella/db";
import { ConflictError, NotFoundError } from "@procella/types";
import { eq } from "drizzle-orm";
import { UnimplementedEvaluatorClient } from "./evaluator-client.js";
import { PostgresEscService } from "./service.js";

const DB_URL =
	process.env.PROCELLA_TEST_DATABASE_URL ??
	process.env.PROCELLA_DATABASE_URL ??
	"postgres://procella:procella@localhost:5432/procella";

const hasDb = async (): Promise<boolean> => {
	try {
		const { db, client } = await createDb({ url: DB_URL });
		await db.select().from(escProjects).limit(1);
		await client.close();
		return true;
	} catch {
		return false;
	}
};

describe.skipIf(!(await hasDb()))("PostgresEscService", () => {
	const tenant = `t-${crypto.randomUUID().slice(0, 8)}`;
	const user = "test-user";
	const evaluator = new UnimplementedEvaluatorClient();
	const encryptionKeyHex = "00".repeat(32);

	let service: PostgresEscService;
	let dbClient: { close(): Promise<void> };

	beforeAll(async () => {
		const { db, client } = await createDb({ url: DB_URL });
		dbClient = client;
		service = new PostgresEscService({ db, evaluator, encryptionKeyHex });
	});

	afterAll(async () => {
		await dbClient.close();
	});

	beforeEach(async () => {
		const { db, client } = await createDb({ url: DB_URL });
		try {
			await db.delete(escProjects).where(eq(escProjects.tenantId, tenant));
		} finally {
			await client.close();
		}
	});

	test("createEnvironment auto-creates project and first revision", async () => {
		const env = await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "dev", yamlBody: "values:\n  foo: bar\n" },
			user,
		);
		expect(env.name).toBe("dev");
		expect(env.currentRevisionNumber).toBe(1);
		expect(env.yamlBody).toContain("foo: bar");

		const list = await service.listEnvironments(tenant, "demo");
		expect(list.map((e) => e.name)).toEqual(["dev"]);

		const revs = await service.listRevisions(tenant, "demo", "dev");
		expect(revs).toHaveLength(1);
		expect(revs[0].revisionNumber).toBe(1);
	});

	test("createEnvironment rejects duplicates with ConflictError", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "dev2", yamlBody: "values: {}" },
			user,
		);
		await expect(
			service.createEnvironment(
				tenant,
				{ projectName: "demo", name: "dev2", yamlBody: "values: {}" },
				user,
			),
		).rejects.toBeInstanceOf(ConflictError);
	});

	test("updateEnvironment creates new revision and bumps number", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "staging", yamlBody: "values: {a: 1}" },
			user,
		);
		const updated = await service.updateEnvironment(
			tenant,
			"demo",
			"staging",
			{ yamlBody: "values: {a: 2}" },
			user,
		);
		expect(updated.currentRevisionNumber).toBe(2);
		expect(updated.yamlBody).toContain("a: 2");

		const revs = await service.listRevisions(tenant, "demo", "staging");
		expect(revs.map((r) => r.revisionNumber)).toEqual([2, 1]);

		const rev1 = await service.getRevision(tenant, "demo", "staging", 1);
		expect(rev1?.yamlBody).toContain("a: 1");
	});

	test("updateEnvironment throws NotFoundError for missing env", async () => {
		await expect(
			service.updateEnvironment(tenant, "nope", "gone", { yamlBody: "values: {}" }, user),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("deleteEnvironment soft-deletes and hides from list", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "doomed", yamlBody: "values: {}" },
			user,
		);
		await service.deleteEnvironment(tenant, "demo", "doomed");
		const list = await service.listEnvironments(tenant, "demo");
		expect(list.find((e) => e.name === "doomed")).toBeUndefined();

		const fetch = await service.getEnvironment(tenant, "demo", "doomed");
		expect(fetch).toBeNull();
	});

	test("can recreate env with same name after soft-delete", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "recycler", yamlBody: "values: {v: 1}" },
			user,
		);
		await service.deleteEnvironment(tenant, "demo", "recycler");
		const recreated = await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "recycler", yamlBody: "values: {v: 2}" },
			user,
		);
		expect(recreated.currentRevisionNumber).toBe(1);
	});

	test("validates env/project names", async () => {
		await expect(
			service.createEnvironment(
				tenant,
				{ projectName: "demo", name: "bad name with spaces", yamlBody: "values: {}" },
				user,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("concurrent updateEnvironment serializes via SELECT FOR UPDATE (no duplicate revision)", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "race", name: "env", yamlBody: "values: {n: 0}" },
			user,
		);
		const results = await Promise.allSettled([
			service.updateEnvironment(tenant, "race", "env", { yamlBody: "values: {n: 1}" }, user),
			service.updateEnvironment(tenant, "race", "env", { yamlBody: "values: {n: 2}" }, user),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		expect(fulfilled).toHaveLength(2);

		const revs = await service.listRevisions(tenant, "race", "env");
		const nums = revs.map((r) => r.revisionNumber).sort((a, b) => a - b);
		expect(nums).toEqual([1, 2, 3]);
	});

	test("concurrent deleteEnvironment is idempotent-safe (transaction + isNull guard)", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "delrace", name: "env", yamlBody: "values: {}" },
			user,
		);
		const results = await Promise.allSettled([
			service.deleteEnvironment(tenant, "delrace", "env"),
			service.deleteEnvironment(tenant, "delrace", "env"),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled").length;
		const rejected = results.filter((r) => r.status === "rejected").length;
		expect(fulfilled).toBeGreaterThanOrEqual(1);
		expect(fulfilled + rejected).toBe(2);

		const fetch = await service.getEnvironment(tenant, "delrace", "env");
		expect(fetch).toBeNull();
	});

	test("tenant isolation — other tenant cannot see envs", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "iso", name: "dev", yamlBody: "values: {secret: 1}" },
			user,
		);
		const otherTenant = `t-other-${crypto.randomUUID().slice(0, 6)}`;
		const list = await service.listEnvironments(otherTenant, "iso");
		expect(list).toEqual([]);
		const fetch = await service.getEnvironment(otherTenant, "iso", "dev");
		expect(fetch).toBeNull();
	});
});
