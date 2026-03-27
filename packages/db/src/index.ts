// @procella/db — Database connection via Drizzle ORM.
//
// Dual-driver design:
//   - Standard PostgreSQL: Bun.sql (native, fastest).
//   - Neon serverless:     @neondatabase/serverless Pool over WebSocket.
//
// The driver is selected automatically based on the connection URL hostname.
// Neon connection strings use *.neon.tech hosts; everything else (localhost,
// 127.0.0.1, Docker hostnames, RDS, Supabase) uses Bun's native driver.

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
// Both BunSQLDatabase and NeonDatabase extend PgDatabase, so consumers get
// the full Drizzle query/mutation/transaction API regardless of the driver.
// biome-ignore lint/suspicious/noExplicitAny: PgDatabase requires QueryResultHKT generic which differs per driver
export type Database = import("drizzle-orm/pg-core").PgDatabase<any, typeof schema>;

/** Options for creating a database connection via URL (Bun.sql or Neon). */
export interface CreateDbUrlOptions {
	/** PostgreSQL connection URL. */
	url: string;
	/** Maximum number of connections in the pool. Defaults to 20. */
	max?: number;
	/** Idle connection timeout in milliseconds. Defaults to 30_000. */
	idleTimeout?: number;
}

/** Options for creating a database connection via AWS RDS Data API. */
export interface CreateDbDataApiOptions {
	driver: "data-api";
	secretArn: string;
	resourceArn: string;
	database: string;
}

export type CreateDbOptions = CreateDbUrlOptions | CreateDbDataApiOptions;

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
 * - Data API driver: AWS RDS Data API (HTTP, no persistent connections)
 * - Neon hosts (*.neon.tech) → @neondatabase/serverless (WebSocket)
 * - All other hosts → Bun.sql (native TCP, fastest)
 *
 * Returns both the Drizzle instance (for type-safe queries) and a client
 * handle (for lifecycle management — call client.close() on shutdown).
 */
export async function createDb(
	options: CreateDbOptions,
): Promise<{ db: Database; client: DbClient }> {
	if ("driver" in options && options.driver === "data-api") {
		const { RDSDataClient } = await import("@aws-sdk/client-rds-data");
		const { drizzle } = await import("drizzle-orm/aws-data-api/pg");
		const rdsClient = new RDSDataClient({});
		const db = drizzle(rdsClient, {
			schema,
			database: options.database,
			secretArn: options.secretArn,
			resourceArn: options.resourceArn,
		});
		return { db: db as Database, client: { close: async () => rdsClient.destroy() } };
	}

	const urlOpts = options as CreateDbUrlOptions;

	if (!isNeonHost(urlOpts.url)) {
		const bunMod = await import("bun");
		const { drizzle } = await import("drizzle-orm/bun-sql");
		const client = new bunMod.SQL({
			url: urlOpts.url,
			max: urlOpts.max ?? 20,
			idleTimeout: Math.max(1, Math.ceil((urlOpts.idleTimeout ?? 30_000) / 1000)),
		});
		const db = drizzle({ client, schema });
		return { db: db as Database, client: { close: () => client.close() } };
	}

	const { neonConfig, Pool } = await import("@neondatabase/serverless");
	const { drizzle } = await import("drizzle-orm/neon-serverless");

	// Fall back to the `ws` npm package only when no global WebSocket is available.
	if (typeof globalThis.WebSocket === "undefined") {
		neonConfig.webSocketConstructor = (await import("ws")).default;
	}

	const pool = new Pool({
		connectionString: urlOpts.url,
		max: urlOpts.max ?? 20,
		idleTimeoutMillis: urlOpts.idleTimeout ?? 30_000,
	});
	const db = drizzle({ client: pool, schema });
	return { db: db as Database, client: { close: () => pool.end() } };
}

/**
 * Convenience overload — create a Drizzle instance from just a URL string.
 */
export async function createDbFromUrl(
	databaseUrl: string,
): Promise<{ db: Database; client: DbClient }> {
	return createDb({ url: databaseUrl } as CreateDbUrlOptions);
}

// ============================================================================
// Migrations
// ============================================================================

export async function runMigrations(
	options: CreateDbOptions | string,
	migrationsFolder: string,
): Promise<void> {
	const resolved: CreateDbOptions =
		typeof options === "string" ? ({ url: options } as CreateDbUrlOptions) : options;

	if ("driver" in resolved && resolved.driver === "data-api") {
		const { RDSDataClient } = await import("@aws-sdk/client-rds-data");
		const { drizzle } = await import("drizzle-orm/aws-data-api/pg");
		const { migrate } = await import("drizzle-orm/aws-data-api/pg/migrator");
		const rdsClient = new RDSDataClient({});
		try {
			const db = drizzle(rdsClient, {
				database: resolved.database,
				secretArn: resolved.secretArn,
				resourceArn: resolved.resourceArn,
			});
			await migrate(db, { migrationsFolder });
		} finally {
			rdsClient.destroy();
		}
		return;
	}

	const urlOpts = resolved as CreateDbUrlOptions;
	const url = urlOpts.url;
	if (!isNeonHost(url)) {
		const bunMod = await import("bun");
		const { drizzle } = await import("drizzle-orm/bun-sql");
		const { migrate } = await import("drizzle-orm/bun-sql/migrator");
		const client = new bunMod.SQL({ url });
		try {
			const db = drizzle({ client });
			await migrate(db, { migrationsFolder });
		} finally {
			await client.close();
		}
		return;
	}

	const { neonConfig, Pool } = await import("@neondatabase/serverless");
	const { drizzle } = await import("drizzle-orm/neon-serverless");
	const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
	if (typeof globalThis.WebSocket === "undefined") {
		neonConfig.webSocketConstructor = (await import("ws")).default;
	}

	const pool = new Pool({ connectionString: url });
	try {
		const db = drizzle({ client: pool });
		await migrate(db, { migrationsFolder });
	} finally {
		await pool.end();
	}
}
