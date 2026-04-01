CREATE TABLE "oidc_trust_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"org_slug" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"issuer" text NOT NULL,
	"max_expiration" integer DEFAULT 7200 NOT NULL,
	"claim_conditions" jsonb NOT NULL,
	"granted_role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_oidc_trust_tenant" ON "oidc_trust_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oidc_trust_org_name" ON "oidc_trust_policies" USING btree ("org_slug","display_name");--> statement-breakpoint
CREATE INDEX "idx_oidc_trust_org_slug" ON "oidc_trust_policies" USING btree ("org_slug");