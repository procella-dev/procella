UPDATE "stacks"
SET "active_update_id" = NULL, "updated_at" = now()
WHERE "active_update_id" IN (
	SELECT "id"
	FROM "updates"
	WHERE "completed_at" IS NOT NULL AND "status" NOT IN ('succeeded', 'failed', 'cancelled')
);
--> statement-breakpoint
UPDATE "updates"
SET "status" = 'failed', "result" = 'failed', "lease_token" = NULL, "lease_expires_at" = NULL, "updated_at" = now()
WHERE "completed_at" IS NOT NULL AND "status" NOT IN ('succeeded', 'failed', 'cancelled');
--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "chk_updates_completed_terminal" CHECK ("completed_at" IS NULL OR "status" IN ('succeeded', 'failed', 'cancelled')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "updates" VALIDATE CONSTRAINT "chk_updates_completed_terminal";
