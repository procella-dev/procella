import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "@procella/db";
import { PostgresEscService, UnimplementedEvaluatorClient } from "@procella/esc";
import { getTestDb, truncateTables } from "./setup.js";

const TENANT_ID = "integ-esc-concurrency";
const USER_ID = "test-user";

let db: Database;
let service: PostgresEscService;

beforeAll(() => {
	db = getTestDb();
	service = new PostgresEscService({
		db,
		evaluator: new UnimplementedEvaluatorClient(),
		encryptionKeyHex: "00".repeat(32),
	});
});

afterEach(async () => {
	await truncateTables();
});

describe("ESC transactional writes", () => {
	test("applies revision preconditions only when supplied", async () => {
		await service.createEnvironment(
			TENANT_ID,
			{ projectName: "demo", name: "env", yamlBody: "values: {n: 0}" },
			USER_ID,
		);

		const tagged = await service.updateEnvironment(
			TENANT_ID,
			"demo",
			"env",
			{ yamlBody: "values: {n: 1}", expectedRevisionNumber: 1 },
			USER_ID,
		);
		expect(tagged.currentRevisionNumber).toBe(2);
		await expect(
			service.updateEnvironment(
				TENANT_ID,
				"demo",
				"env",
				{ yamlBody: "values: {n: stale}", expectedRevisionNumber: 1 },
				USER_ID,
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED", statusCode: 412 });

		const untagged = await service.updateEnvironment(
			TENANT_ID,
			"demo",
			"env",
			{ yamlBody: "values: {n: 2}" },
			USER_ID,
		);
		expect(untagged.currentRevisionNumber).toBe(3);
	});

	test("guards draft edits and terminal transitions", async () => {
		await service.createEnvironment(
			TENANT_ID,
			{ projectName: "demo", name: "env", yamlBody: "values: {n: 0}" },
			USER_ID,
		);
		const appliedDraft = await service.createDraft(
			TENANT_ID,
			"demo",
			"env",
			"values: {n: 1}",
			"",
			USER_ID,
		);
		const editedDraft = await service.updateDraft(
			TENANT_ID,
			"demo",
			"env",
			appliedDraft.id,
			"values: {n: 2}",
			appliedDraft.updatedAt.getTime(),
		);
		expect(editedDraft.yamlBody).toBe("values: {n: 2}");
		await expect(
			service.updateDraft(
				TENANT_ID,
				"demo",
				"env",
				appliedDraft.id,
				"values: {n: stale}",
				editedDraft.updatedAt.getTime() - 1,
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED", statusCode: 412 });
		expect((await service.applyDraft(TENANT_ID, "demo", "env", appliedDraft.id, USER_ID)).status).toBe(
			"applied",
		);

		const discardedDraft = await service.createDraft(
			TENANT_ID,
			"demo",
			"env",
			"values: {n: 3}",
			"",
			USER_ID,
		);
		await service.discardDraft(TENANT_ID, "demo", "env", discardedDraft.id);
		expect((await service.getDraft(TENANT_ID, "demo", "env", discardedDraft.id))?.status).toBe(
			"discarded",
		);
	});
});
