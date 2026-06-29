DROP INDEX "idx_oidc_trust_org_issuer";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oidc_trust_org_issuer" ON "oidc_trust_policies" USING btree ("tenant_id","org_slug","issuer");
