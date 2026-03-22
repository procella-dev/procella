// @procella/db — Database connection via Drizzle ORM.
//
// Dual-driver design:
//   - Production (Neon): @neondatabase/serverless Pool over WebSocket.
//   - Local dev / CI:    pg (node-postgres) Pool over TCP.
//
// The driver is selected automatically based on the connection URL hostname.
// Neon connection strings use *.neon.tech hosts; everything else (localhost,
// 127.0.0.1, Docker hostnames) falls back to node-postgres.

import { schema } from "./schema.js";

// Re-export schema for consumers
export {
	checkpoints,
	journalEntries,
	projects,
	schema,
	stacks,
	updateEvents,
	updates,
} from "./schema.js";

// ============================================================================
// Types
// ============================================================================

/** Drizzle database instance with full schema type inference. */
// Both NeonDatabase and NodePgDatabase extend PgDatabase, so consumers get
// the full Drizzle query/mutation/transaction API regardless of the driver.
// biome-ignore lint/suspicious/noExplicitAny: PgDatabase requires QueryResultHKT generic which differs per driver
export type Database = import("drizzle-orm/pg-core").PgDatabase<any, typeof schema>;

/** Options for creating a database connection. */
export interface CreateDbOptions {
	/** PostgreSQL connection URL. */
	url: string;
	/** Maximum number of connections in the pool. Defaults to 20. */
	max?: number;
	/** Idle connection timeout in milliseconds. Defaults to 30_000. */
	idleTimeout?: number;
}

/** Wrapper around the connection pool for lifecycle management. */
export interface DbClient {
	/** Shut down the connection pool. */
	close(): Promise<void>;
}

// ============================================================================
// Driver Detection
// ============================================================================

function isNeonHost(url: string): boolean {
	try {
		// PostgreSQL URLs use postgres:// or postgresql:// scheme.
		// URL parser needs a known scheme — swap to http for parsing.
		const normalized = url.replace(/^postgres(ql)?:\/\//, "http://");
		const { hostname } = new URL(normalized);
		return hostname.endsWith(".neon.tech");
	} catch {
		return false;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Drizzle database instance with automatic driver selection.
 *
 * - Neon hosts (*.neon.tech) → @neondatabase/serverless (WebSocket)
 * - All other hosts → pg / node-postgres (TCP)
 *
 * Returns both the Drizzle instance (for type-safe queries) and a client
 * handle (for lifecycle management — call client.close() on shutdown).
 */
export async function createDb(
	options: CreateDbOptions,
): Promise<{ db: Database; client: DbClient }> {
	const poolOpts = {
		connectionString: options.url,
		max: options.max ?? 20,
		idleTimeoutMillis: options.idleTimeout ?? 30_000,
	};

	if (!isNeonHost(options.url)) {
		// Local dev / CI / Docker / any non-Neon host — use node-postgres (TCP).
		const pg = await import("pg");
		const { drizzle } = await import("drizzle-orm/node-postgres");
		const pool = new pg.default.Pool(poolOpts);
		const db = drizzle({ client: pool, schema });
		return { db: db as Database, client: { close: () => pool.end() } };
	}

	// Production — use Neon serverless (WebSocket).
	const { neonConfig, Pool } = await import("@neondatabase/serverless");
	const { drizzle } = await import("drizzle-orm/neon-serverless");
	const ws = (await import("ws")).default;
	neonConfig.webSocketConstructor = ws;

	const pool = new Pool(poolOpts);
	const db = drizzle({ client: pool, schema });
	return { db: db as Database, client: { close: () => pool.end() } };
}

/**
 * Convenience overload — create a Drizzle instance from just a URL string.
 */
export async function createDbFromUrl(
	databaseUrl: string,
): Promise<{ db: Database; client: DbClient }> {
	return createDb({ url: databaseUrl });
}
