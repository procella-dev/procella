CREATE TABLE "checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb,
	"blob_key" text,
	"is_delta" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_update_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "updates" (
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
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_events" ADD CONSTRAINT "update_events_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_checkpoints_update_version" ON "checkpoints" USING btree ("update_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_projects_tenant_name" ON "projects" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_stacks_project_name" ON "stacks" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_update_events_update_sequence" ON "update_events" USING btree ("update_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_updates_active" ON "updates" USING btree ("stack_id") WHERE status IN ('not started', 'requested', 'running');