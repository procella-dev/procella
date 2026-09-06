import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@procella/db";
import { getTestDbUrl } from "./setup.js";

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
			"SELECT pg_sleep(0.25);",
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

		await Promise.all([
			runMigrations(databaseUrl.toString(), migrationsFolder),
			runMigrations(databaseUrl.toString(), migrationsFolder),
		]);

		const database = new SQL({ url: databaseUrl.toString() });
		try {
			const [probe] = await database.unsafe(
				"SELECT (SELECT count(*)::int FROM migration_lock_probe) AS ddl_rows, (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS journal_rows",
			);
			expect(probe).toEqual({ ddl_rows: 1, journal_rows: 1 });
		} finally {
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
