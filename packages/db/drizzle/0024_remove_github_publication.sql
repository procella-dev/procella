DROP TABLE "github_update_outbox";
--> statement-breakpoint
ALTER TABLE "updates" DROP COLUMN "github_target";
--> statement-breakpoint
ALTER TABLE "updates" DROP COLUMN "github_comment_id";
--> statement-breakpoint
ALTER TABLE "updates" DROP COLUMN "summary_sequence";
--> statement-breakpoint
ALTER TABLE "updates" DROP COLUMN "summary";
