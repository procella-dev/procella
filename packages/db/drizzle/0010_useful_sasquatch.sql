ALTER TABLE "updates" ADD CONSTRAINT "chk_updates_kind" CHECK ("updates"."kind" IN ('update', 'preview', 'refresh', 'destroy', 'import'));
