-- Migration order: follows 0019_terminal_update_completion on main; sibling H11b owns 0021.
CREATE TABLE "blob_cleanup_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blob_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"claimed_by" uuid,
	"claimed_until" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_blob_cleanup_queue_blob_key" ON "blob_cleanup_queue" USING btree ("blob_key");
--> statement-breakpoint
CREATE INDEX "idx_blob_cleanup_queue_available" ON "blob_cleanup_queue" USING btree ("available_at", "claimed_until");
--> statement-breakpoint
CREATE INDEX "idx_updates_stack_id" ON "updates" USING btree ("stack_id");
--> statement-breakpoint
INSERT INTO "blob_cleanup_queue" ("blob_key")
SELECT DISTINCT checkpoint."blob_key"
FROM "checkpoints" checkpoint
INNER JOIN "updates" orphan_update ON orphan_update."id" = checkpoint."update_id"
WHERE checkpoint."blob_key" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "stacks" stack
		WHERE stack."id" = orphan_update."stack_id"
	)
	AND NOT EXISTS (
		SELECT 1
		FROM "checkpoints" retained_checkpoint
		INNER JOIN "updates" retained_update ON retained_update."id" = retained_checkpoint."update_id"
		INNER JOIN "stacks" retained_stack ON retained_stack."id" = retained_update."stack_id"
		WHERE retained_checkpoint."blob_key" = checkpoint."blob_key"
	)
ON CONFLICT ("blob_key") DO NOTHING;
--> statement-breakpoint
DELETE FROM "updates" orphan_update
WHERE NOT EXISTS (
	SELECT 1
	FROM "stacks" stack
	WHERE stack."id" = orphan_update."stack_id"
);
--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "updates" VALIDATE CONSTRAINT "updates_stack_id_stacks_id_fk";
