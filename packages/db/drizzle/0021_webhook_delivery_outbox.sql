-- Portfolio migration order: H1 reserves 0019, H10b reserves 0020, H11b uses 0021.
ALTER TABLE "updates" ADD COLUMN "webhook_context" jsonb;
--> statement-breakpoint
CREATE TABLE "webhook_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"claimed_by" uuid,
	"claimed_until" timestamp,
	"failed_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_webhook_outbox_webhook" ON "webhook_outbox" USING btree ("webhook_id");
--> statement-breakpoint
CREATE INDEX "idx_webhook_outbox_available" ON "webhook_outbox" USING btree ("available_at", "claimed_until");
