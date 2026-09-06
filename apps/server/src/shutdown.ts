// @procella/server — ordered drain for graceful shutdown.
//
// Ordering matters: a dashboard SSE subscription is an in-flight response that
// stays open until its notification stream ends, and `Bun.serve().stop()` waits
// for in-flight responses. Closing the notification hub first ends those
// streams, so the server drains instead of hitting the force-exit timeout.

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
 * Drain in dependency order: subscriptions, then the HTTP server, then
 * background workers. Never reorder `notifications` after `server` — the
 * server cannot finish draining while subscription responses are still open.
 */
export async function drainForShutdown({
	notifications,
	server,
	workers,
}: DrainTargets): Promise<void> {
	await notifications.close();
	await server.stop();
	for (const worker of workers) await worker.stop();
}
