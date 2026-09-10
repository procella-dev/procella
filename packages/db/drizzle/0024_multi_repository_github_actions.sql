DROP INDEX "idx_oidc_trust_org_issuer";
--> statement-breakpoint
CREATE INDEX "idx_oidc_trust_org_issuer" ON "oidc_trust_policies" USING btree ("org_slug", "issuer");
