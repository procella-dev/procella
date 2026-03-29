#!/usr/bin/env bun
// Migration script with retry logic for Neon compute wake-up.
// Uses shared runMigrations() from @procella/db for driver selection.

import { ensureDatabase, runMigrations } from "@procella/db";

const DATABASE_URL = process.env.PROCELLA_DATABASE_URL;
if (!DATABASE_URL) throw new Error("PROCELLA_DATABASE_URL is required");

try {
	const parsed = new URL(DATABASE_URL.replace(/^postgres(ql)?:\/\//, "http://"));
	const dbName = parsed.pathname.slice(1).split("?")[0];
	console.log(
		`Target: ${parsed.hostname}:${parsed.port || 5432} db=${dbName} (neon=${parsed.hostname.endsWith(".neon.tech")})`,
	);
	if (dbName && dbName !== "postgres") {
		const adminUrl = DATABASE_URL.replace(`/${dbName}`, "/postgres");
		await ensureDatabase(adminUrl, dbName);
		console.log(`Database "${dbName}" ensured.`);
	}
} catch (err) {
	console.error("Database ensure failed (non-fatal):", err);
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;
const MIGRATIONS_FOLDER = "packages/db/drizzle";

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
	try {
		console.log(`Running migrations (attempt ${attempt})...`);
		await runMigrations(DATABASE_URL, MIGRATIONS_FOLDER);
		console.log("Migrations complete.");
		process.exit(0);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (err instanceof Error) {
			if (err.cause) console.error("Cause:", err.cause);
			if ("code" in err) console.error("PG code:", (err as Record<string, unknown>).code);
			if ("detail" in err) console.error("PG detail:", (err as Record<string, unknown>).detail);
			if ("severity" in err)
				console.error("PG severity:", (err as Record<string, unknown>).severity);
		}
		console.error(`Attempt ${attempt} failed: ${msg}`);
		if (attempt === MAX_RETRIES) {
			console.error("All migration attempts failed.");
			process.exit(1);
		}
		console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
		await Bun.sleep(RETRY_DELAY_MS);
	}
}
