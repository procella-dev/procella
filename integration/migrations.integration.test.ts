import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@procella/db";
import { MIGRATIONS_ADVISORY_LOCK_ID } from "../packages/db/src/migration-lock.js";
import { getTestDbUrl } from "./setup.js";

const MIGRATION_BARRIER_LOCK_ID = MIGRATIONS_ADVISORY_LOCK_ID + 1n;

test("concurrent migrators serialize DDL and journal writes", async () => {
	const { SQL } = require("bun") as typeof import("bun");
	const databaseName = `procella_migration_lock_${crypto.randomUUID().replaceAll("-", "")}`;
	const adminUrl = new URL(getTestDbUrl());
	adminUrl.pathname = "/postgres";
	const databaseUrl = new URL(getTestDbUrl());
	databaseUrl.pathname = `/${databaseName}`;

	const migrationsFolder = await mkdtemp(join(tmpdir(), "procella-migrations-"));
	await mkdir(join(migrationsFolder, "meta"));
	await writeFile(
		join(migrationsFolder, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "postgresql",
			entries: [
				{
					idx: 0,
					version: "7",
					when: 1_900_000_000_000,
					tag: "0000_concurrent_probe",
					breakpoints: true,
				},
			],
		}),
	);
	await writeFile(
		join(migrationsFolder, "0000_concurrent_probe.sql"),
		[
			`SELECT pg_advisory_lock(${MIGRATION_BARRIER_LOCK_ID});`,
			"--> statement-breakpoint",
			"CREATE TABLE migration_lock_probe (id integer PRIMARY KEY);",
			"--> statement-breakpoint",
			"INSERT INTO migration_lock_probe (id) VALUES (1);",
		].join("\n"),
	);

	const admin = new SQL({ url: adminUrl.toString() });
	let databaseCreated = false;
	try {
		await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
		databaseCreated = true;

		const database = new SQL({ url: databaseUrl.toString() });
		const barrierConnection = await database.reserve();
		let barrierLocked = false;
		let migrationRuns: Promise<void>[] = [];
		let migrationRun: Promise<void[]> | undefined;
		try {
			// Stop the first migrator after its journal read, then observe the second waiting
			// on the production lock before allowing either invocation to execute DDL.
			await barrierConnection.unsafe(`SELECT pg_advisory_lock(${MIGRATION_BARRIER_LOCK_ID})`);
			barrierLocked = true;
			migrationRuns = [
				runMigrations(databaseUrl.toString(), migrationsFolder),
				runMigrations(databaseUrl.toString(), migrationsFolder),
			];
			migrationRun = Promise.all(migrationRuns);
			migrationRun.catch(() => {});

			const deadline = performance.now() + 5_000;
			let waitingLockIds: string[] = [];
			while (performance.now() < deadline) {
				const rows = await barrierConnection.unsafe(
					"SELECT ((classid::bigint << 32) | objid::bigint)::text AS lock_id FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND NOT granted",
				);
				waitingLockIds = rows.map((row) => String(row.lock_id));
				if (
					waitingLockIds.includes(MIGRATION_BARRIER_LOCK_ID.toString()) &&
					waitingLockIds.includes(MIGRATIONS_ADVISORY_LOCK_ID.toString())
				) {
					break;
				}
			}
			expect(waitingLockIds).toContain(MIGRATION_BARRIER_LOCK_ID.toString());
			expect(waitingLockIds).toContain(MIGRATIONS_ADVISORY_LOCK_ID.toString());

			await barrierConnection.unsafe(
				`SELECT pg_advisory_unlock(${MIGRATION_BARRIER_LOCK_ID})`,
			);
			barrierLocked = false;
			await migrationRun;

			const [probe] = await database.unsafe(
				"SELECT (SELECT count(*)::int FROM migration_lock_probe) AS ddl_rows, (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS journal_rows",
			);
			expect(probe).toEqual({ ddl_rows: 1, journal_rows: 1 });
		} finally {
			if (barrierLocked) {
				await barrierConnection.unsafe(
					`SELECT pg_advisory_unlock(${MIGRATION_BARRIER_LOCK_ID})`,
				);
			}
			await Promise.allSettled(migrationRuns);
			barrierConnection.release();
			await database.close();
		}
	} finally {
		if (databaseCreated) {
			await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
		}
		await admin.close();
		await rm(migrationsFolder, { recursive: true, force: true });
	}
});
