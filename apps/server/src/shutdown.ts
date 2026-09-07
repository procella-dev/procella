// @procella/server — concurrent drain for graceful shutdown.
//
// `drainForShutdown()` closes the notification hub and stops `Bun.serve()`
// together. Sequencing either one first is wrong: server-first can deadlock on
// in-flight SSE responses until the force-exit timer, and hub-first leaves Bun
// accepting new requests while teardown runs.

/** Ends live subscriptions so their SSE responses can complete. */
export interface SubscriptionDrain {
	close(): Promise<void>;
}

/** The HTTP server being drained — `Bun.serve()`'s handle. */
export interface ServerDrain {
	stop(): Promise<void>;
}

/** A background worker with a bounded stop. */
export interface WorkerDrain {
	stop(): Promise<void>;
}

export interface DrainTargets {
	notifications: SubscriptionDrain;
	server: ServerDrain;
	workers: WorkerDrain[];
}

/**
 * Halt admission and end subscription streams together, then stop background
 * workers. Sequencing these two is wrong in either direction: stopping the
 * server first deadlocks on in-flight SSE responses until the force-exit
 * timer, and closing the hub first leaves Bun accepting new requests while
 * listener teardown runs.
 */
export async function drainForShutdown({
	notifications,
	server,
	workers,
}: DrainTargets): Promise<void> {
	await Promise.all([notifications.close(), server.stop()]);
	for (const worker of workers) await worker.stop();
}
