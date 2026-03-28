const MIGRATIONS: string[] = [
	// 0000_medical_fabian_cortez.sql
	`CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb,
	"blob_key" text,
	"is_delta" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
)`,
	`CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`,
	`CREATE TABLE "stacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_update_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
)`,
	`CREATE TABLE "update_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
)`,
	`CREATE TABLE "updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'not started' NOT NULL,
	"result" text,
	"message" text,
	"version" integer DEFAULT 1 NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"config" jsonb,
	"program" jsonb
)`,
	`ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action`,
	`ALTER TABLE "stacks" ADD CONSTRAINT "stacks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action`,
	`ALTER TABLE "update_events" ADD CONSTRAINT "update_events_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action`,
	`CREATE UNIQUE INDEX "idx_checkpoints_update_version" ON "checkpoints" USING btree ("update_id","version")`,
	`CREATE UNIQUE INDEX "idx_projects_tenant_name" ON "projects" USING btree ("tenant_id","name")`,
	`CREATE UNIQUE INDEX "idx_stacks_project_name" ON "stacks" USING btree ("project_id","name")`,
	`CREATE UNIQUE INDEX "idx_update_events_update_sequence" ON "update_events" USING btree ("update_id","sequence")`,
	`CREATE UNIQUE INDEX "idx_updates_active" ON "updates" USING btree ("stack_id") WHERE status IN ('not started', 'requested', 'running')`,
	// 0001_add_journal_entries.sql
	`CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"sequence_id" bigint NOT NULL,
	"operation_id" bigint NOT NULL,
	"kind" integer NOT NULL,
	"state" jsonb,
	"operation_type" text,
	"elide_write" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
)`,
	`ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action`,
	`CREATE UNIQUE INDEX "idx_journal_entries_update_seq" ON "journal_entries" USING btree ("update_id","sequence_id")`,
	// 0002_extend_journal_entries.sql
	`ALTER TABLE "journal_entries" ADD COLUMN "operation" jsonb`,
	`ALTER TABLE "journal_entries" ADD COLUMN "secrets_provider" jsonb`,
	`ALTER TABLE "journal_entries" ADD COLUMN "new_snapshot" jsonb`,
	`ALTER TABLE "journal_entries" ADD COLUMN "remove_old" bigint`,
	`ALTER TABLE "journal_entries" ADD COLUMN "remove_new" bigint`,
];

(async () => {
	const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API!;
	const BASE_URL = `http://${RUNTIME_API}/2018-06-01/runtime`;

	const { loadConfig } = await import("@procella/config");
	const config = loadConfig();

	const res = await fetch(`${BASE_URL}/invocation/next`);
	const requestId = res.headers.get("Lambda-Runtime-Aws-Request-Id")!;

	try {
		const { SQL } = require("bun") as typeof import("bun");
		const db = new SQL({ url: config.databaseUrl as string });

		const applied: string[] = [];
		const skipped: string[] = [];

		for (const stmt of MIGRATIONS) {
			await db
				.unsafe(stmt)
				.then(() => applied.push(stmt.substring(0, 40)))
				.catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.includes("already exists") || msg.includes("duplicate column")) {
						skipped.push(stmt.substring(0, 40));
						return;
					}
					throw err;
				});
		}

		await db.close();
		await fetch(`${BASE_URL}/invocation/${requestId}/response`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				status: "ok",
				applied: applied.length,
				skipped: skipped.length,
			}),
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
