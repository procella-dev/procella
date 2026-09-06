import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { escEnvironments, type Database } from "@procella/db";
import { PostgresEscService, UnimplementedEvaluatorClient } from "@procella/esc";
import { eq, sql } from "drizzle-orm";
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

async function waitForBlockedTransactions(
	blockerPid: number,
	expectedCount: number,
): Promise<void> {
	while (true) {
		const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(sql`(
				WITH RECURSIVE blocked(pid) AS (
					SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
					UNION
					SELECT activity.pid
					FROM pg_stat_activity activity
					INNER JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
				)
				SELECT pid FROM blocked
			) AS blocked_transactions`);
		if (Number(row?.count) >= expectedCount) return;
	}
}

describe("ESC transactional writes", () => {
	test("serializes contending writers and applies revision preconditions only when supplied", async () => {
		const env = await service.createEnvironment(
			TENANT_ID,
			{ projectName: "demo", name: "env", yamlBody: "values: {n: 0}" },
			USER_ID,
		);
		let writes: Promise<unknown>[] = [];
		await db.transaction(async (tx) => {
			const [locked] = await tx
				.select({ pid: sql<number>`pg_backend_pid()` })
				.from(escEnvironments)
				.where(eq(escEnvironments.id, env.id))
				.for("update", { of: escEnvironments });
			writes = [
				service.updateEnvironment(
					TENANT_ID,
					"demo",
					"env",
					{ yamlBody: "values: {n: 1}", expectedRevisionNumber: 1 },
					USER_ID,
				),
				service.updateEnvironment(
					TENANT_ID,
					"demo",
					"env",
					{ yamlBody: "values: {n: 2}", expectedRevisionNumber: 1 },
					USER_ID,
				),
			];
			const earlySettlement = Promise.race(
				writes.map((write, index) =>
					write.then(
						() => Promise.reject(new Error(`Write ${index + 1} completed before blocking`)),
						(error) => Promise.reject(error),
					),
				),
			);
			await Promise.race([waitForBlockedTransactions(locked.pid, writes.length), earlySettlement]);
		});

		const results = await Promise.allSettled(writes);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const [rejected] = results.filter((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ reason: { code: "PRECONDITION_FAILED", statusCode: 412 } });

		const untagged = await service.updateEnvironment(
			TENANT_ID,
			"demo",
			"env",
			{ yamlBody: "values: {n: 3}" },
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
