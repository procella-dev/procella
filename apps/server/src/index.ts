// @procella/server — Bun.serve entrypoint for local development.
//
// Production uses vercel.ts instead. This file is only used for local dev
// via `bun run apps/server/src/index.ts`.

import { GCWorker } from "@procella/updates";

// Healthcheck probe — runs inside the same compiled binary to avoid shipping
// a separate health binary. Must exit before any server bootstrap.
if (process.argv.includes("--healthz")) {
	const port = (process.env.PROCELLA_LISTEN_ADDR ?? ":9090").split(":").pop() || "9090";
	fetch(`http://localhost:${port}/healthz`)
		.then((res) => process.exit(res.ok ? 0 : 1))
		.catch(() => process.exit(1));
} else {
	const { app, auth, config, db, client } = await import("./bootstrap.js");

	const [, portStr] = config.listenAddr.split(":");
	const port = Number.parseInt(portStr || "9090", 10);

	const server = Bun.serve({
		fetch: app.fetch,
		port,
		hostname: "0.0.0.0",
	});

	// biome-ignore lint/suspicious/noConsole: server startup log
	console.log(`Procella listening on ${server.hostname}:${server.port}`);

	// GC Worker (errors caught internally — won't crash the process)
	const gc = new GCWorker({ db });
	void gc.start();

	// Graceful shutdown — stop accepting new connections, drain in-flight requests,
	// then force-close after timeout.
	const DRAIN_TIMEOUT_MS = 10_000;
	const shutdown = async () => {
		const forceTimer = setTimeout(() => {
			server.stop(true);
			void client.close();
			process.exit(1);
		}, DRAIN_TIMEOUT_MS);
		forceTimer.unref();

		await server.stop();
		await gc.stop();
		auth.dispose?.();
		await client.close();
		clearTimeout(forceTimer);
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
