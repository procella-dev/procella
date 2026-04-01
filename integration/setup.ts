// Integration test lifecycle — uses real PostgreSQL (docker-compose or CI service).
// Pattern: runMigrations in beforeAll, truncateTables in afterEach.

import { afterAll, beforeAll } from "bun:test";
import { createDb, runMigrations, type Database, type DbClient } from "@procella/db";

const TEST_DB_URL =
	process.env.TEST_DATABASE_URL ??
	process.env.PROCELLA_DATABASE_URL ??
	"postgres://procella:procella@localhost:5432/procella?sslmode=disable";

const MIGRATIONS_PATH = new URL("../packages/db/drizzle", import.meta.url).pathname;

let _db: Database;
let _client: DbClient;

export function getTestDb(): Database {
	if (!_db) throw new Error("Test DB not initialized — is setup.ts loaded via --preload?");
	return _db;
}

export function getTestDbUrl(): string {
	return TEST_DB_URL;
}

export async function truncateTables(): Promise<void> {
	const { SQL } = require("bun") as typeof import("bun");
	const sql = new SQL({ url: TEST_DB_URL });
	await sql.unsafe(
		"TRUNCATE webhook_deliveries, webhooks, github_installations, update_events, journal_entries, checkpoints, updates, stacks, projects CASCADE",
	);
	await sql.close();
}

beforeAll(async () => {
	// Apply migrations (idempotent — drizzle-kit skips already-applied)
	await runMigrations(TEST_DB_URL, MIGRATIONS_PATH);

	// Create Drizzle instance for tests
	const result = await createDb({ url: TEST_DB_URL });
	_db = result.db;
	_client = result.client;
});

afterAll(async () => {
	await _client?.close();
});
