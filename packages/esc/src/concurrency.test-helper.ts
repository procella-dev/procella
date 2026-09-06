import { createDb, type Database } from "@procella/db";
import { sql } from "drizzle-orm";

type TestTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function waitForBlockedTransactions(
	db: Database,
	blockerPid: number,
	expectedCount: number,
): Promise<void> {
	while (true) {
		const [row] = await db
			.select({
				count: sql<number>`count(*)::int`,
				blockerAlive: sql<boolean>`EXISTS (
					SELECT 1 FROM pg_stat_activity WHERE pid = ${blockerPid}
				)`,
			})
			.from(sql`(
				WITH RECURSIVE blocked(pid) AS (
					SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
					UNION
					SELECT activity.pid
					FROM pg_stat_activity activity
					INNER JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
				)
				SELECT pid FROM blocked
			) AS blocked_transactions`);
		if (Number(row?.count) >= expectedCount) return;
		if (!row?.blockerAlive) {
			throw new Error("Blocker transaction ended before contention was observed");
		}
	}
}

export async function runBehindRowLock(
	monitorDb: Database,
	databaseUrl: string,
	lockRow: (tx: TestTransaction) => Promise<number>,
	startOperations: () => Promise<unknown>[],
): Promise<PromiseSettledResult<unknown>[]> {
	const { db: lockDb, client: lockClient } = await createDb({ url: databaseUrl, max: 1 });
	const acquired = deferred<number>();
	const release = deferred<void>();
	const blocker = lockDb.transaction(async (tx) => {
		// PostgreSQL owns this failure-only deadline so a broken synchronizer cannot retain a row lock.
		await tx.execute(sql`SET LOCAL transaction_timeout = '5s'`);
		acquired.resolve(await lockRow(tx));
		await release.promise;
	});
	void blocker.catch(acquired.reject);

	const operations: Promise<unknown>[] = [];
	let waitFailure: unknown;
	try {
		const blockerPid = await acquired.promise;
		operations.push(...startOperations());
		const earlySettlement = Promise.race(
			operations.map((operation, index) =>
				operation.then(
					() => Promise.reject(new Error(`Operation ${index + 1} completed before blocking`)),
					(error) => Promise.reject(error),
				),
			),
		);
		await Promise.race([
			waitForBlockedTransactions(monitorDb, blockerPid, operations.length),
			earlySettlement,
		]);
	} catch (error) {
		waitFailure = error;
	} finally {
		release.resolve();
		await blocker.catch(() => {});
		await lockClient.close();
	}
	const results = await Promise.allSettled(operations);
	if (waitFailure) throw waitFailure;
	return results;
}
