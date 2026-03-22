ALTER TABLE "journal_entries" ADD COLUMN "operation" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "secrets_provider" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "new_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "remove_old" bigint;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "remove_new" bigint;
