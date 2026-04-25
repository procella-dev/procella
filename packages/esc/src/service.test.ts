import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AesCryptoService } from "@procella/crypto";
import { createDb, type Database, escProjects, escSessions } from "@procella/db";
import { ConflictError, NotFoundError } from "@procella/types";
import { eq } from "drizzle-orm";
import {
	type EvaluatePayload,
	type EvaluateResult,
	type EvaluatorClient,
	UnimplementedEvaluatorClient,
} from "./evaluator-client.js";
import { EscEvaluationError, extractImports, PostgresEscService } from "./service.js";

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

	test("createEnvironment defaults empty yamlBody to values block", async () => {
		const env = await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "empty", yamlBody: "" },
			user,
		);
		expect(env.yamlBody).toBe("values: {}\n");
	});

	test("listAllEnvironments returns org/project/name summaries", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj-a", name: "alpha", yamlBody: "values: {}" },
			user,
		);
		await service.createEnvironment(
			tenant,
			{ projectName: "proj-b", name: "beta", yamlBody: "values: {}" },
			user,
		);

		const result = await service.listAllEnvironments(tenant, {
			orgFilter: "dev-org",
			projectFilter: "proj-a",
		});
		expect(result.nextToken).toBe("");
		expect(result.environments).toEqual([
			{ organization: "dev-org", project: "proj-a", name: "alpha" },
		]);
	});

	test("cloneEnvironment copies source yaml into destination", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "src", name: "base", yamlBody: "values:\n  greeting: hello\n" },
			user,
		);

		const cloned = await service.cloneEnvironment(
			tenant,
			"src",
			"base",
			{ project: "dest", name: "copy" },
			user,
		);
		expect(cloned.yamlBody).toBe("values:\n  greeting: hello\n");

		const fetched = await service.getEnvironment(tenant, "dest", "copy");
		expect(fetched?.yamlBody).toBe("values:\n  greeting: hello\n");
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

describe("PostgresEscService.validateYaml", () => {
	const service = new PostgresEscService({
		db: {} as Database,
		evaluator: new UnimplementedEvaluatorClient(),
		encryptionKeyHex: "00".repeat(32),
	});

	test("extracts top-level values from valid yaml", async () => {
		const result = await service.validateYaml("values:\n  greeting: hello\n  count: 42\n");
		expect(result.diagnostics).toEqual([]);
		expect(result.values).toEqual({ greeting: "hello", count: 42 });
	});

	test("surfaces yaml parser diagnostics", async () => {
		const result = await service.validateYaml("values: [oops\n");
		expect(result.values).toEqual({});
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// Revision tags / Environment tags / Drafts tests
// ============================================================================

describe.skipIf(!(await hasDb()))("PostgresEscService — revision tags", () => {
	const tenant = `t-rtag-${crypto.randomUUID().slice(0, 8)}`;
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

	test("tagRevision + listRevisionTags round-trip", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "dev", yamlBody: "values: {a: 1}" },
			user,
		);
		await service.tagRevision(tenant, "demo", "dev", 1, "stable", user);
		const tags = await service.listRevisionTags(tenant, "demo", "dev");
		expect(tags).toHaveLength(1);
		expect(tags[0].name).toBe("stable");
		expect(tags[0].revisionNumber).toBe(1);
	});

	test("tagRevision upserts — moves tag to new revision", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env1", yamlBody: "values: {a: 1}" },
			user,
		);
		await service.updateEnvironment(tenant, "demo", "env1", { yamlBody: "values: {a: 2}" }, user);
		await service.tagRevision(tenant, "demo", "env1", 1, "stable", user);
		await service.tagRevision(tenant, "demo", "env1", 2, "stable", user);
		const tags = await service.listRevisionTags(tenant, "demo", "env1");
		expect(tags).toHaveLength(1);
		expect(tags[0].revisionNumber).toBe(2);
	});

	test("untagRevision removes a tag", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env2", yamlBody: "values: {}" },
			user,
		);
		await service.tagRevision(tenant, "demo", "env2", 1, "canary", user);
		await service.untagRevision(tenant, "demo", "env2", "canary");
		const tags = await service.listRevisionTags(tenant, "demo", "env2");
		expect(tags).toHaveLength(0);
	});

	test("untagRevision throws NotFoundError for missing tag", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env3", yamlBody: "values: {}" },
			user,
		);
		await expect(service.untagRevision(tenant, "demo", "env3", "nope")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("tagRevision validates tag name", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env4", yamlBody: "values: {}" },
			user,
		);
		await expect(
			service.tagRevision(tenant, "demo", "env4", 1, "bad name!", user),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe.skipIf(!(await hasDb()))("PostgresEscService — environment tags", () => {
	const tenant = `t-etag-${crypto.randomUUID().slice(0, 8)}`;
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

	test("getEnvironmentTags returns empty object for new env", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "dev", yamlBody: "values: {}" },
			user,
		);
		const tags = await service.getEnvironmentTags(tenant, "demo", "dev");
		expect(tags).toEqual({});
	});

	test("setEnvironmentTags replaces all tags", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env1", yamlBody: "values: {}" },
			user,
		);
		await service.setEnvironmentTags(tenant, "demo", "env1", { env: "prod", tier: "gold" });
		const tags = await service.getEnvironmentTags(tenant, "demo", "env1");
		expect(tags).toEqual({ env: "prod", tier: "gold" });

		await service.setEnvironmentTags(tenant, "demo", "env1", { env: "staging" });
		const tags2 = await service.getEnvironmentTags(tenant, "demo", "env1");
		expect(tags2).toEqual({ env: "staging" });
	});

	test("updateEnvironmentTags patches — null removes key", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env2", yamlBody: "values: {}" },
			user,
		);
		await service.setEnvironmentTags(tenant, "demo", "env2", { a: "1", b: "2" });
		await service.updateEnvironmentTags(tenant, "demo", "env2", { b: null, c: "3" });
		const tags = await service.getEnvironmentTags(tenant, "demo", "env2");
		expect(tags).toEqual({ a: "1", c: "3" });
	});

	test("setEnvironmentTags validates max 64 tags", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env3", yamlBody: "values: {}" },
			user,
		);
		const tooMany: Record<string, string> = {};
		for (let i = 0; i < 65; i++) {
			tooMany[`key${i}`] = `val${i}`;
		}
		await expect(service.setEnvironmentTags(tenant, "demo", "env3", tooMany)).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
	});

	test("setEnvironmentTags validates value length", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env4", yamlBody: "values: {}" },
			user,
		);
		await expect(
			service.setEnvironmentTags(tenant, "demo", "env4", { key: "x".repeat(257) }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe.skipIf(!(await hasDb()))("PostgresEscService — drafts", () => {
	const tenant = `t-draft-${crypto.randomUUID().slice(0, 8)}`;
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

	test("createDraft + getDraft round-trip", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "dev", yamlBody: "values: {a: 1}" },
			user,
		);
		const draft = await service.createDraft(
			tenant,
			"demo",
			"dev",
			"values: {a: 2}",
			"bump a",
			user,
		);
		expect(draft.status).toBe("open");
		expect(draft.yamlBody).toBe("values: {a: 2}");
		expect(draft.description).toBe("bump a");

		const fetched = await service.getDraft(tenant, "demo", "dev", draft.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.id).toBe(draft.id);
	});

	test("updateDraft changes yamlBody for open drafts", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "editable", yamlBody: "values: {a: 1}" },
			user,
		);
		const draft = await service.createDraft(
			tenant,
			"demo",
			"editable",
			"values: {a: 2}",
			"edit me",
			user,
		);

		const updated = await service.updateDraft(
			tenant,
			"demo",
			"editable",
			draft.id,
			"values: {a: 3}",
		);
		expect(updated.yamlBody).toBe("values: {a: 3}");
	});

	test("listDrafts returns all drafts, filterable by status", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env1", yamlBody: "values: {}" },
			user,
		);
		await service.createDraft(tenant, "demo", "env1", "values: {x: 1}", "d1", user);
		const d2 = await service.createDraft(tenant, "demo", "env1", "values: {x: 2}", "d2", user);
		await service.discardDraft(tenant, "demo", "env1", d2.id);

		const all = await service.listDrafts(tenant, "demo", "env1");
		expect(all).toHaveLength(2);

		const open = await service.listDrafts(tenant, "demo", "env1", "open");
		expect(open).toHaveLength(1);
		expect(open[0].status).toBe("open");

		const discarded = await service.listDrafts(tenant, "demo", "env1", "discarded");
		expect(discarded).toHaveLength(1);
		expect(discarded[0].status).toBe("discarded");
	});

	test("applyDraft creates new revision and updates env", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env2", yamlBody: "values: {a: 1}" },
			user,
		);
		const draft = await service.createDraft(
			tenant,
			"demo",
			"env2",
			"values: {a: 99}",
			"apply test",
			user,
		);
		const applied = await service.applyDraft(tenant, "demo", "env2", draft.id, user);
		expect(applied.status).toBe("applied");
		expect(applied.appliedRevisionId).toBeTruthy();
		expect(applied.appliedAt).not.toBeNull();

		const env = await service.getEnvironment(tenant, "demo", "env2");
		expect(env?.currentRevisionNumber).toBe(2);
		expect(env?.yamlBody).toBe("values: {a: 99}");

		const revs = await service.listRevisions(tenant, "demo", "env2");
		expect(revs.map((r) => r.revisionNumber)).toContain(2);
	});

	test("applyDraft rejects already-applied draft", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env3", yamlBody: "values: {}" },
			user,
		);
		const draft = await service.createDraft(tenant, "demo", "env3", "values: {b: 1}", "", user);
		await service.applyDraft(tenant, "demo", "env3", draft.id, user);
		await expect(service.applyDraft(tenant, "demo", "env3", draft.id, user)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("discardDraft sets status to discarded", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env4", yamlBody: "values: {}" },
			user,
		);
		const draft = await service.createDraft(tenant, "demo", "env4", "values: {c: 1}", "", user);
		await service.discardDraft(tenant, "demo", "env4", draft.id);
		const fetched = await service.getDraft(tenant, "demo", "env4", draft.id);
		expect(fetched?.status).toBe("discarded");
	});

	test("discardDraft rejects already-discarded draft", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env5", yamlBody: "values: {}" },
			user,
		);
		const draft = await service.createDraft(tenant, "demo", "env5", "values: {}", "", user);
		await service.discardDraft(tenant, "demo", "env5", draft.id);
		await expect(service.discardDraft(tenant, "demo", "env5", draft.id)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("getDraft returns null for missing draft", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "demo", name: "env6", yamlBody: "values: {}" },
			user,
		);
		const fetched = await service.getDraft(tenant, "demo", "env6", crypto.randomUUID());
		expect(fetched).toBeNull();
	});
});

describe("extractImports", () => {
	test("parses zero-indent block sequences", () => {
		expect(extractImports("imports:\n- shared\n- prod\n")).toEqual(["shared", "prod"]);
	});

	test("parses mixed-indent block sequences", () => {
		expect(extractImports("imports:\n  - shared\n    - prod\n")).toEqual(["shared", "prod"]);
	});

	test("skips comments and blank lines in block sequences", () => {
		expect(extractImports("imports:\n  - a\n  # comment\n\n  - b\n")).toEqual(["a", "b"]);
	});

	test("strips quotes from block sequence items", () => {
		expect(extractImports("imports:\n  - \"shared/env\"\n  - 'prod/env'\n")).toEqual([
			"shared/env",
			"prod/env",
		]);
	});

	test("parses flow sequences with quoted values", () => {
		expect(extractImports("imports: [\"a\", 'b']\n")).toEqual(["a", "b"]);
	});

	test("header regex does not backtrack on pathological whitespace input", () => {
		const input = `imports:${" ".repeat(50000)}[a]`;
		const start = performance.now();
		const result = extractImports(input);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
		expect(result).toEqual(["a"]);
	});

	test("block-item regex does not backtrack on pathological trailing spaces", () => {
		const line = `  - val${" ".repeat(50000)}`;
		const input = `imports:\n${line}\n`;
		const start = performance.now();
		const result = extractImports(input);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
		expect(result).toEqual(["val"]);
	});
});

// ============================================================================
// Session tests — openSession / getSession with mocked evaluator
// ============================================================================

class MockEvaluatorClient implements EvaluatorClient {
	lastPayload: EvaluatePayload | null = null;
	result: EvaluateResult = { values: { foo: "bar" }, secrets: [], diagnostics: [] };

	async evaluate(payload: EvaluatePayload): Promise<EvaluateResult> {
		this.lastPayload = payload;
		return this.result;
	}
}

describe.skipIf(!(await hasDb()))("PostgresEscService — sessions", () => {
	const tenant = `t-sess-${crypto.randomUUID().slice(0, 8)}`;
	const user = "test-user";
	const encryptionKeyHex = "00".repeat(32);

	let mockEval: MockEvaluatorClient;
	let service: PostgresEscService;
	let dbClient: { close(): Promise<void> };

	beforeAll(async () => {
		const { db, client } = await createDb({ url: DB_URL });
		dbClient = client;
		mockEval = new MockEvaluatorClient();
		service = new PostgresEscService({
			db,
			evaluator: mockEval,
			encryptionKeyHex,
		});
	});

	afterAll(async () => {
		await dbClient.close();
	});

	beforeEach(async () => {
		const { db, client } = await createDb({ url: DB_URL });
		try {
			mockEval.result = { values: { foo: "bar" }, secrets: [], diagnostics: [] };
			mockEval.lastPayload = null;
			await db.delete(escProjects).where(eq(escProjects.tenantId, tenant));
		} finally {
			await client.close();
		}
	});

	test("openSession stores encrypted ciphertext + returns values inline", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "dev", yamlBody: "values:\n  foo: bar\n" },
			user,
		);

		const result = await service.openSession(tenant, "proj", "dev");

		expect(result.sessionId).toBeTruthy();
		expect(result.values).toEqual({ foo: "bar" });
		expect(result.secrets).toEqual([]);
		expect(result.expiresAt).toBeInstanceOf(Date);
		expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

		const { db: verifyDb, client: verifyClient } = await createDb({ url: DB_URL });
		try {
			const [row] = await verifyDb
				.select()
				.from(escSessions)
				.where(eq(escSessions.id, result.sessionId))
				.limit(1);
			expect(row).toBeTruthy();
			expect(row.resolvedValuesCiphertext).toBeTruthy();
			expect(row.resolvedValuesCiphertext).not.toContain("foo");

			const cryptoSvc = new AesCryptoService(encryptionKeyHex);
			const envFQN = `${tenant}/proj/dev`;
			const cipherBytes = Buffer.from(row.resolvedValuesCiphertext, "base64");
			const plainBytes = await cryptoSvc.decrypt(new Uint8Array(cipherBytes), envFQN);
			const decrypted = JSON.parse(new TextDecoder().decode(plainBytes));
			expect(decrypted).toEqual({ foo: "bar" });
		} finally {
			await verifyClient.close();
		}
	});

	test("openSession collects imports recursively", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "shared", yamlBody: "values:\n  x: 1\n" },
			user,
		);
		await service.createEnvironment(
			tenant,
			{
				projectName: "proj",
				name: "app",
				yamlBody: "imports:\n  - shared\nvalues:\n  y: 2\n",
			},
			user,
		);

		await service.openSession(tenant, "proj", "app");

		expect(mockEval.lastPayload).toBeTruthy();
		expect(mockEval.lastPayload?.imports).toEqual({
			"proj/shared": "values:\n  x: 1\n",
		});
	});

	test("openSession detects import cycles", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "a", yamlBody: "imports:\n  - b\nvalues: {}" },
			user,
		);
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "b", yamlBody: "imports:\n  - a\nvalues: {}" },
			user,
		);

		await expect(service.openSession(tenant, "proj", "a")).rejects.toThrow("import_cycle");
	});

	test("openSession throws EscEvaluationError for evaluator error diagnostics", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "bad", yamlBody: "values: {}" },
			user,
		);
		const env = await service.getEnvironment(tenant, "proj", "bad");
		if (!env) {
			throw new Error("expected environment to exist");
		}

		mockEval.result = {
			values: null as unknown as Record<string, unknown>,
			secrets: [],
			diagnostics: [{ severity: "error", summary: "unknown provider aws-login" }],
		};

		try {
			await service.openSession(tenant, "proj", "bad");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(EscEvaluationError);
			const evalErr = err as EscEvaluationError;
			expect(evalErr.statusCode).toBe(422);
			expect(evalErr.diagnostics).toHaveLength(1);
			expect(evalErr.diagnostics[0].summary).toContain("aws-login");
		}

		const { db: verifyDb, client: verifyClient } = await createDb({ url: DB_URL });
		try {
			const rows = await verifyDb
				.select()
				.from(escSessions)
				.where(eq(escSessions.environmentId, env.id));
			expect(rows).toHaveLength(0);
		} finally {
			await verifyClient.close();
		}
	});

	test("openSession still creates sessions for warning-only diagnostics", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "warn", yamlBody: "values: {}" },
			user,
		);
		mockEval.result = {
			values: { ok: true },
			secrets: [],
			diagnostics: [{ severity: "warning", summary: "deprecated field" }],
		};

		const result = await service.openSession(tenant, "proj", "warn");
		expect(result.values).toEqual({ ok: true });

		const env = await service.getEnvironment(tenant, "proj", "warn");
		if (!env) {
			throw new Error("expected environment to exist");
		}
		const { db: verifyDb, client: verifyClient } = await createDb({ url: DB_URL });
		try {
			const rows = await verifyDb
				.select()
				.from(escSessions)
				.where(eq(escSessions.environmentId, env.id));
			expect(rows).toHaveLength(1);
		} finally {
			await verifyClient.close();
		}
	});

	test("getSession returns decrypted values for fresh session", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "fresh", yamlBody: "values:\n  key: value\n" },
			user,
		);
		mockEval.result = { values: { key: "value" }, secrets: ["key"], diagnostics: [] };

		const opened = await service.openSession(tenant, "proj", "fresh");
		const fetched = await service.getSession(tenant, "proj", "fresh", opened.sessionId);

		expect(fetched).not.toBeNull();
		expect(fetched?.sessionId).toBe(opened.sessionId);
		expect(fetched?.values).toEqual({ key: "value" });
		expect(fetched?.secrets).toEqual(["key"]);
		expect(fetched?.expiresAt.getTime()).toBe(opened.expiresAt.getTime());
	});

	test("getSession returns null for expired session", async () => {
		const { db: shortDb, client: shortClient } = await createDb({ url: DB_URL });
		const shortTtlService = new PostgresEscService({
			db: shortDb,
			evaluator: mockEval,
			encryptionKeyHex,
			sessionTtlSeconds: 0,
		});

		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "expiry", yamlBody: "values: {}" },
			user,
		);

		const opened = await shortTtlService.openSession(tenant, "proj", "expiry");
		await new Promise((r) => setTimeout(r, 50));
		const fetched = await shortTtlService.getSession(tenant, "proj", "expiry", opened.sessionId);
		expect(fetched).toBeNull();
		await shortClient.close();
	});

	test("getSession returns null for closed session", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "closed", yamlBody: "values: {}" },
			user,
		);

		const opened = await service.openSession(tenant, "proj", "closed");

		const { db: updateDb, client: updateClient } = await createDb({ url: DB_URL });
		try {
			await updateDb
				.update(escSessions)
				.set({ closedAt: new Date() })
				.where(eq(escSessions.id, opened.sessionId));
		} finally {
			await updateClient.close();
		}

		const fetched = await service.getSession(tenant, "proj", "closed", opened.sessionId);
		expect(fetched).toBeNull();
	});

	test("getSession returns null for unknown sessionId", async () => {
		await service.createEnvironment(
			tenant,
			{ projectName: "proj", name: "missing", yamlBody: "values: {}" },
			user,
		);

		const fetched = await service.getSession(tenant, "proj", "missing", crypto.randomUUID());
		expect(fetched).toBeNull();
	});
});

// ============================================================================
// GC sweep tests — escGcSweep / gcSweep
// ============================================================================

describe.skipIf(!(await hasDb()))("PostgresEscService — GC sweep", () => {
	const tenant = `t-gc-${crypto.randomUUID().slice(0, 8)}`;
	const user = "test-user";
	const encryptionKeyHex = "00".repeat(32);

	let mockEval: MockEvaluatorClient;
	let service: PostgresEscService;
	let db: Database;
	let dbClient: { close(): Promise<void> };

	beforeAll(async () => {
		const result = await createDb({ url: DB_URL });
		db = result.db;
		dbClient = result.client;
		mockEval = new MockEvaluatorClient();
		service = new PostgresEscService({ db, evaluator: mockEval, encryptionKeyHex });
	});

	afterAll(async () => {
		await dbClient.close();
	});

	beforeEach(async () => {
		const { db: cleanDb, client: cleanClient } = await createDb({ url: DB_URL });
		try {
			mockEval.result = { values: { foo: "bar" }, secrets: [], diagnostics: [] };
			mockEval.lastPayload = null;
			await cleanDb.delete(escProjects).where(eq(escProjects.tenantId, tenant));
		} finally {
			await cleanClient.close();
		}
	});

	test("gcSweep closes expired+open sessions, leaves others unchanged", async () => {
		// Pre-clean: sweep any pre-existing stale sessions from other test runs
		await service.gcSweep();

		await service.createEnvironment(
			tenant,
			{ projectName: "gc-proj", name: "dev", yamlBody: "values:\n  a: 1\n" },
			user,
		);

		const shortTtlService = new PostgresEscService({
			db,
			evaluator: mockEval,
			encryptionKeyHex,
			sessionTtlSeconds: 0,
		});

		// Session 1: expired + open (should be closed by GC)
		const session1 = await shortTtlService.openSession(tenant, "gc-proj", "dev");
		await new Promise((r) => setTimeout(r, 50));

		// Session 2: expired + already closed (should be unchanged)
		const session2 = await shortTtlService.openSession(tenant, "gc-proj", "dev");
		await new Promise((r) => setTimeout(r, 50));
		const { db: updateDb, client: updateClient } = await createDb({ url: DB_URL });
		try {
			await updateDb
				.update(escSessions)
				.set({ closedAt: new Date() })
				.where(eq(escSessions.id, session2.sessionId));
		} finally {
			await updateClient.close();
		}

		// Session 3: active (default 1hr TTL, should be unchanged)
		const session3 = await service.openSession(tenant, "gc-proj", "dev");

		const result = await service.gcSweep();
		expect(result.closedCount).toBe(1);

		// Verify DB state of each session
		const { db: checkDb, client: checkClient } = await createDb({ url: DB_URL });
		try {
			const [s1] = await checkDb
				.select()
				.from(escSessions)
				.where(eq(escSessions.id, session1.sessionId))
				.limit(1);
			expect(s1.closedAt).not.toBeNull();

			const [s2] = await checkDb
				.select()
				.from(escSessions)
				.where(eq(escSessions.id, session2.sessionId))
				.limit(1);
			expect(s2.closedAt).not.toBeNull();

			const [s3] = await checkDb
				.select()
				.from(escSessions)
				.where(eq(escSessions.id, session3.sessionId))
				.limit(1);
			expect(s3.closedAt).toBeNull();
		} finally {
			await checkClient.close();
		}
	});
});
