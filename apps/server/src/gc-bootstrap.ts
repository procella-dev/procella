import type { ScheduledEvent } from "aws-lambda";

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const { loadConfig } = await import("@procella/config");
	const { createDb } = await import("@procella/db");
	const { escGcSweep } = await import("@procella/esc");
	const { GCWorker } = await import("@procella/updates");

	const config = loadConfig();
	const { db } = await createDb({ url: config.databaseUrl, max: config.databasePoolMax });
	const gcWorker = new GCWorker({ db });

	while (true) {
		const res = await fetch(`${BASE_URL}/invocation/next`);
		const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;
		void ((await res.json()) as ScheduledEvent);

		try {
			await gcWorker.runOnce();
			await escGcSweep(db);
			await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "ok" }),
			});
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			await fetch(`${BASE_URL}/invocation/${requestId}/error`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					errorMessage: error.message,
					errorType: error.name,
					stackTrace: error.stack?.split("\n") || [],
				}),
			});
		}
	}
})();
