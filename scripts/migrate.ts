#!/usr/bin/env bun
// Migration script with automatic driver selection.
// Uses @neondatabase/serverless for Neon hosts (CI preview), node-postgres
// for local/Docker hosts. Retries on connection failure (Neon compute wake-up).

export {}; // Make file a module for top-level await

const DATABASE_URL = process.env.PROCELLA_DATABASE_URL;
if (!DATABASE_URL) throw new Error("PROCELLA_DATABASE_URL is required");

// Log connection target (host only, no credentials)
try {
	const parsed = new URL(DATABASE_URL.replace(/^postgres(ql)?:\/\//, "http://"));
	console.log(
		`Target: ${parsed.hostname}:${parsed.port || 5432} (neon=${parsed.hostname.endsWith(".neon.tech")})`,
	);
} catch {
	/* ignore parse errors */
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;
const MIGRATIONS_FOLDER = "packages/db/drizzle";

function isNeonHost(connUrl: string): boolean {
	try {
		const normalized = connUrl.replace(/^postgres(ql)?:\/\//, "http://");
		return new URL(normalized).hostname.endsWith(".neon.tech");
	} catch {
		return false;
	}
}

async function runMigrations(dbUrl: string): Promise<void> {
	if (isNeonHost(dbUrl)) {
		// Neon: use @neondatabase/serverless over WebSocket (reliable with Neon SNI)
		const { neonConfig, Pool } = await import("@neondatabase/serverless");
		const { drizzle } = await import("drizzle-orm/neon-serverless");
		const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
		const ws = (await import("ws")).default;
		neonConfig.webSocketConstructor = ws;
		const pool = new Pool({ connectionString: dbUrl });
		// Verify connectivity before running migrations
		const res = await pool.query("SELECT current_database(), current_user, version()");
		console.log(`Connected to ${res.rows[0].current_database} as ${res.rows[0].current_user}`);
		const db = drizzle({ client: pool });
		await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		await pool.end();
	} else {
		// Local / CI / Docker: use node-postgres over TCP
		const pg = await import("pg");
		const { drizzle } = await import("drizzle-orm/node-postgres");
		const { migrate } = await import("drizzle-orm/node-postgres/migrator");
		const pool = new pg.default.Pool({ connectionString: dbUrl });
		const db = drizzle({ client: pool });
		await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		await pool.end();
	}
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
	try {
		console.log(`Running migrations (attempt ${attempt})...`);
		await runMigrations(DATABASE_URL);
		console.log("Migrations complete.");
		process.exit(0);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// Log full error chain for debugging PG error codes
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
