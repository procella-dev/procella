#!/usr/bin/env bun
// Migration script that uses Bun's native postgres driver (supports Neon SNI).
// Equivalent to `drizzle-kit migrate` but works with Neon serverless endpoints.
// Retries on connection close (Neon compute wake-up).

import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { SQL } from "bun";

const url = process.env.PROCELLA_DATABASE_URL;
if (!url) {
	console.error("PROCELLA_DATABASE_URL is required");
	process.exit(1);
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
	let client: InstanceType<typeof SQL> | undefined;
	try {
		client = new SQL(url);
		const db = drizzle({ client });
		console.log(`Running migrations (attempt ${attempt})...`);
		await migrate(db, { migrationsFolder: "packages/db/drizzle" });
		console.log("Migrations complete.");
		client.close();
		process.exit(0);
	} catch (err) {
		client?.close();
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`Attempt ${attempt} failed: ${msg}`);
		if (attempt === MAX_RETRIES) {
			console.error("All migration attempts failed.");
			process.exit(1);
		}
		console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
		await Bun.sleep(RETRY_DELAY_MS);
	}
}