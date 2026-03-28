import m1 from "../../../packages/db/drizzle/0000_medical_fabian_cortez.sql" with { type: "file" };
import m2 from "../../../packages/db/drizzle/0001_add_journal_entries.sql" with { type: "file" };
import m3 from "../../../packages/db/drizzle/0002_extend_journal_entries.sql" with { type: "file" };

const JOURNAL = JSON.stringify({
	version: "7",
	dialect: "postgresql",
	entries: [
		{
			idx: 0,
			version: "7",
			when: 1772914464231,
			tag: "0000_medical_fabian_cortez",
			breakpoints: true,
		},
		{
			idx: 1,
			version: "7",
			when: 1772914500000,
			tag: "0001_add_journal_entries",
			breakpoints: true,
		},
		{
			idx: 2,
			version: "7",
			when: 1772914600000,
			tag: "0002_extend_journal_entries",
			breakpoints: true,
		},
	],
});

const SQL_FILES: Record<string, string> = {
	"0000_medical_fabian_cortez.sql": m1,
	"0001_add_journal_entries.sql": m2,
	"0002_extend_journal_entries.sql": m3,
};

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const { loadConfig } = await import("@procella/config");
	const { runMigrations } = await import("@procella/db");

	const config = loadConfig();

	const res = await fetch(`${BASE_URL}/invocation/next`);
	const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;

	try {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");

		const migrationsDir = join(tmpdir(), `procella-migrations-${Date.now()}`);
		mkdirSync(join(migrationsDir, "meta"), { recursive: true });

		writeFileSync(join(migrationsDir, "meta", "_journal.json"), JOURNAL);

		for (const [name, embeddedPath] of Object.entries(SQL_FILES)) {
			writeFileSync(join(migrationsDir, name), await Bun.file(embeddedPath).text());
		}

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
