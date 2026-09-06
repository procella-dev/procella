ALTER TABLE "updates" ADD CONSTRAINT "chk_updates_completed_terminal" CHECK (NOT ("completed_at" IS NOT NULL AND "status" IN ('not started', 'requested', 'running'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "updates" VALIDATE CONSTRAINT "chk_updates_completed_terminal";
