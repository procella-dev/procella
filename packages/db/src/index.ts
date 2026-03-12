// @procella/db — Database connection via Neon serverless + Drizzle ORM.
//
// Uses @neondatabase/serverless (WebSocket mode) as the connection driver.
// Drizzle ORM wraps it for type-safe queries with schema inference.
// WebSocket mode is required for interactive transactions (db.transaction()).

import { neonConfig, Pool } from "@neondatabase/serverless";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { schema } from "./schema.js";

// Node.js does not have a global WebSocket — provide the ws library.
neonConfig.webSocketConstructor = ws;

// Re-export schema for consumers
export {
	checkpoints,
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
export type Database = NeonDatabase<typeof schema>;

/** Options for creating a database connection. */
export interface CreateDbOptions {
	/** PostgreSQL connection URL. */
	url: string;
	/** Maximum number of connections in the pool. Defaults to 20. */
	max?: number;
	/** Idle connection timeout in milliseconds. Defaults to 30 000. */
	idleTimeout?: number;
}

/** Wrapper around Neon Pool for lifecycle management. */
export interface DbClient {
	/** Shut down the connection pool. */
	close(): Promise<void>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Drizzle database instance backed by Neon serverless (WebSocket).
 *
 * Returns both the Drizzle instance (for type-safe queries) and a client
 * handle (for lifecycle management — call client.close() on shutdown).
 */
export function createDb(options: CreateDbOptions): { db: Database; client: DbClient } {
	const pool = new Pool({
		connectionString: options.url,
		max: options.max ?? 20,
		idleTimeoutMillis: (options.idleTimeout ?? 30) * 1000,
	});

	const db = drizzle({ client: pool, schema });

	return {
		db,
		client: {
			close: () => pool.end(),
		},
	};
}

/**
 * Convenience overload — create a Drizzle instance from just a URL string.
 */
export function createDbFromUrl(databaseUrl: string): { db: Database; client: DbClient } {
	return createDb({ url: databaseUrl });
}
