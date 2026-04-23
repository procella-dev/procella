CREATE TABLE "esc_environment_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"yaml_body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esc_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"yaml_body" text NOT NULL,
	"current_revision_number" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esc_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esc_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"resolved_values_ciphertext" text NOT NULL,
	"secret_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_oidc_trust_org_slug";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_oidc_trust_org_name";--> statement-breakpoint
ALTER TABLE "esc_environment_revisions" ADD CONSTRAINT "esc_environment_revisions_environment_id_esc_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."esc_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esc_environments" ADD CONSTRAINT "esc_environments_project_id_esc_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."esc_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esc_sessions" ADD CONSTRAINT "esc_sessions_environment_id_esc_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."esc_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "esc_sessions" ADD CONSTRAINT "esc_sessions_revision_id_esc_environment_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."esc_environment_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_esc_revisions_env_number" ON "esc_environment_revisions" USING btree ("environment_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_esc_envs_project_name" ON "esc_environments" USING btree ("project_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_esc_projects_tenant_name" ON "esc_projects" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "idx_esc_sessions_env" ON "esc_sessions" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_esc_sessions_expires_active" ON "esc_sessions" USING btree ("expires_at") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_oidc_trust_org_issuer" ON "oidc_trust_policies" USING btree ("org_slug","issuer");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oidc_trust_org_name" ON "oidc_trust_policies" USING btree ("tenant_id","org_slug","display_name");