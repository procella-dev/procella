// @procella/db — Database connection via Bun's built-in SQL + Drizzle ORM.
//
// Uses Bun.sql (import { SQL } from "bun") as the connection driver.
// Drizzle ORM wraps it for type-safe queries with schema inference.

import { SQL } from "bun";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { drizzle } from "drizzle-orm/bun-sql";
import { schema } from "./schema.js";

export type { BunSQLDatabase };

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
export type Database = BunSQLDatabase<typeof schema>;

/** Options for creating a database connection. */
export interface CreateDbOptions {
	/** PostgreSQL connection URL. */
	url: string;
	/** Maximum number of connections in the pool. Defaults to 20. */
	max?: number;
	/** Idle connection timeout in seconds. Defaults to 30. */
	idleTimeout?: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Drizzle database instance backed by Bun's built-in SQL driver.
 *
 * Returns both the Drizzle instance (for type-safe queries) and the raw
 * SQL client (for cases where raw queries or lifecycle management is needed).
 */
export function createDb(options: CreateDbOptions): { db: Database; client: SQL } {
	const client = new SQL({
		url: options.url,
		max: options.max ?? 20,
		idleTimeout: options.idleTimeout ?? 30,
	});
	const db = drizzle({ client, schema });
	return { db, client };
}

/**
 * Convenience overload — create a Drizzle instance from just a URL string.
 */
export function createDbFromUrl(databaseUrl: string): { db: Database; client: SQL } {
	return createDb({ url: databaseUrl });
}
