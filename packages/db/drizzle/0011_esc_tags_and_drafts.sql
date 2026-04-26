CREATE TABLE "esc_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"yaml_body" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"applied_revision_id" uuid,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esc_revision_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "esc_environments" ADD COLUMN "tags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "esc_drafts" ADD CONSTRAINT "esc_drafts_environment_id_esc_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."esc_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esc_drafts" ADD CONSTRAINT "esc_drafts_applied_revision_id_esc_environment_revisions_id_fk" FOREIGN KEY ("applied_revision_id") REFERENCES "public"."esc_environment_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esc_revision_tags" ADD CONSTRAINT "esc_revision_tags_environment_id_esc_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."esc_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esc_revision_tags" ADD CONSTRAINT "esc_revision_tags_revision_id_esc_environment_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."esc_environment_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_esc_drafts_env" ON "esc_drafts" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_esc_drafts_status" ON "esc_drafts" USING btree ("environment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_esc_rev_tags_env_name" ON "esc_revision_tags" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "idx_esc_rev_tags_revision" ON "esc_revision_tags" USING btree ("revision_id");