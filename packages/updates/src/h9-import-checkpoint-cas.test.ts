import { describe, expect, test } from "bun:test";
import { checkpoints, type Database } from "@procella/db";
import { desc } from "drizzle-orm";
import { CHECKPOINT_HEAD_ORDER, PostgresUpdatesService } from "./postgres.js";
import { ImportConflictError } from "./types.js";

const crypto = {} as never;

function staleRepairDatabase() {
	const sourceCheckpoint = {
		id: "checkpoint-source",
		updateId: "update-source",
		stackId: "stack-1",
		version: 1,
		data: null,
		blobKey: "checkpoints/stack-1/update-source/1",
		isDelta: false,
		createdAt: new Date("2026-01-01T00:00:00Z"),
	};
	let headCheckpoint = sourceCheckpoint;
	let insertCount = 0;
	let signalExportStarted: () => void = () => {};
	let releaseExport: () => void = () => {};
	const exportStarted = new Promise<void>((resolve) => {
		signalExportStarted = resolve;
	});
	const exportCanFinish = new Promise<void>((resolve) => {
		releaseExport = resolve;
	});
	const storage = {
		get: async () => {
			signalExportStarted();
			await exportCanFinish;
			return new TextEncoder().encode(
				JSON.stringify({
					resources: [
						{
							urn: "urn:pulumi:dev::project::pkg:type:Child::child",
							parent: "urn:missing",
						},
					],
				}),
			);
		},
	} as never;

	const db = {
		select: () => {
			let deterministicOrder = false;
			const query = {
				from: () => query,
				where: () => query,
				orderBy: (...columns: unknown[]) => {
					deterministicOrder = columns[1] === CHECKPOINT_HEAD_ORDER[1];
					return query;
				},
				limit: () => Promise.resolve([deterministicOrder ? headCheckpoint : sourceCheckpoint]),
			};
			return query;
		},
		execute: () =>
			Promise.resolve([
				{
					activeUpdateId: null,
					tenantId: "tenant-1",
					project: "project",
					stack: "dev",
					tags: {},
				},
			]),
		insert: () => {
			insertCount += 1;
			throw new Error("repair must not insert after the checkpoint head advances");
		},
		transaction: (callback: (tx: unknown) => unknown) => callback(db),
	} as unknown as Database;

	return {
		db,
		storage,
		exportStarted,
		completeNewerUpdate: () => {
			headCheckpoint = {
				...sourceCheckpoint,
				id: "checkpoint-completed-update",
				createdAt: sourceCheckpoint.createdAt,
			};
		},
		releaseExport,
		insertCount: () => insertCount,
	};
}

function importDatabase() {
	let executeCount = 0;
	let insertedUpdate: Record<string, unknown> | undefined;
	let insertedCheckpoint: Record<string, unknown> | undefined;
	const db = {
		select: () => {
			const query = {
				from: () => query,
				where: () => Promise.resolve([{ maxVersion: 4 }]),
			};
			return query;
		},
		execute: () => {
			executeCount += 1;
			if (executeCount === 1) {
				return Promise.resolve([
					{
						activeUpdateId: null,
						tenantId: "tenant-1",
						project: "project",
						stack: "dev",
						tags: {},
					},
				]);
			}
			if (executeCount === 2) {
				return Promise.resolve([
					{
						stackId: "stack-1",
						status: "succeeded",
						version: 5,
						leaseToken: null,
						leaseExpiresAt: null,
					},
				]);
			}
			return Promise.resolve([{ nextVersion: 1 }]);
		},
		insert: () => {
			let values: Record<string, unknown>;
			const query = {
				values: (next: Record<string, unknown>) => {
					values = next;
					return query;
				},
				returning: () => {
					insertedUpdate = values;
					return Promise.resolve([{ id: "import-update" }]);
				},
				onConflictDoUpdate: () => {
					insertedCheckpoint = values;
					return Promise.resolve();
				},
			};
			return query;
		},
		transaction: (callback: (tx: unknown) => unknown) => callback(db),
	} as unknown as Database;

	return {
		db,
		insertedUpdate: () => insertedUpdate,
		insertedCheckpoint: () => insertedCheckpoint,
	};
}

describe("H9 repair checkpoint compare-and-swap", () => {
	test("rejects repair when a completed update advances the checkpoint after export", async () => {
		expect(CHECKPOINT_HEAD_ORDER).toHaveLength(2);
		expect(CHECKPOINT_HEAD_ORDER[1]).toEqual(desc(checkpoints.id));
		const { db, storage, exportStarted, completeNewerUpdate, releaseExport, insertCount } =
			staleRepairDatabase();
		const service = new PostgresUpdatesService({ db, storage, crypto });

		const repair = service.repairStack("stack-1");
		await exportStarted;
		completeNewerUpdate();
		releaseExport();

		await expect(repair).rejects.toMatchObject({
			name: ImportConflictError.name,
			message: "Cannot repair because the stack checkpoint changed",
		});
		expect(insertCount()).toBe(0);
	});

	test("keeps ordinary Pulumi imports independent of the repair precondition", async () => {
		const { db, insertedUpdate, insertedCheckpoint } = importDatabase();
		const service = new PostgresUpdatesService({ db, storage: {} as never, crypto });
		const deployment = { version: 3, deployment: { resources: [] } };

		await expect(service.importStack("stack-1", deployment)).resolves.toEqual({
			updateId: "import-update",
		});
		expect(insertedUpdate()).toMatchObject({ kind: "import", status: "succeeded", version: 5 });
		expect(insertedCheckpoint()).toMatchObject({
			updateId: "import-update",
			stackId: "stack-1",
			version: 1,
			data: deployment.deployment,
		});
	});
});
