import type { Caller } from "../auth.js";
import type { Context } from "../router/trpc.js";

// ── Test Caller ──────────────────────────────────────────────────────────────

export function testCaller(overrides?: Partial<Caller>): Caller {
	return {
		userId: "test-user-id",
		login: "test-user",
		org: "test-org",
		role: "admin",
		...overrides,
	};
}

// ── Drizzle Query Mock ───────────────────────────────────────────────────────
// Creates a chainable mock that mimics Drizzle's query builder pattern:
//   db.select(...).from(...).innerJoin(...).where(...).orderBy(...).limit(...).offset(...)
//
// The result is determined by a resolver function that receives the chain calls
// made so far, letting tests return different data for different queries.

interface ChainCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

type QueryResolver = (calls: readonly ChainCall[]) => unknown[];

/**
 * Build a mock Drizzle `db` that returns data via the resolver.
 * The resolver is called once the chain is awaited (via `.then()`).
 */
export function mockDb(resolver: QueryResolver): Context["db"] {
	function createChain(calls: ChainCall[]): unknown {
		return new Proxy(
			{},
			{
				get(_target, prop: string) {
					if (prop === "then") {
						// When the chain is awaited, call the resolver
						const result = resolver(calls);
						return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
							try {
								resolve(result);
							} catch (err) {
								reject(err);
							}
						};
					}
					// For any other method call, record it and continue the chain
					return (...args: unknown[]) => {
						return createChain([...calls, { method: prop, args }]);
					};
				},
			},
		);
	}

	return new Proxy(
		{},
		{
			get(_target, prop: string) {
				return (...args: unknown[]) => {
					return createChain([{ method: prop, args }]);
				};
			},
		},
	) as Context["db"];
}

// ── Convenience: static mock that always returns the same rows ───────────────

export function staticDb(rows: unknown[]): Context["db"] {
	return mockDb(() => rows);
}

// ── Context builder ──────────────────────────────────────────────────────────

export function testContext(db: Context["db"], caller?: Partial<Caller>): Context {
	return { db, caller: testCaller(caller) };
}
