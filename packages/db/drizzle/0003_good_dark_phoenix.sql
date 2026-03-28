CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"sequence_id" bigint NOT NULL,
	"operation_id" bigint NOT NULL,
	"kind" integer NOT NULL,
	"state" jsonb,
	"operation" jsonb,
	"secrets_provider" jsonb,
	"new_snapshot" jsonb,
	"operation_type" text,
	"remove_old" bigint,
	"remove_new" bigint,
	"elide_write" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_journal_entries_update_seq" ON "journal_entries" USING btree ("update_id","sequence_id");