import { join } from "node:path";

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const { loadConfig } = await import("@procella/config");
	const { runMigrations } = await import("@procella/db");

	const config = loadConfig();
	const migrationsDir = join(import.meta.dir, "drizzle");

	const res = await fetch(`${BASE_URL}/invocation/next`);
	const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;

	try {
		await runMigrations(config.databaseUrl as string, migrationsDir);

		await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "ok", message: "Migrations complete" }),
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
})();
