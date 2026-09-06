CREATE TABLE "subscription_ticket_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_subscription_ticket_nonces_expires" ON "subscription_ticket_nonces" USING btree ("expires_at");
