-- Pre-flight: verify no cross-tenant duplicates
-- SELECT org_slug, issuer, COUNT(DISTINCT tenant_id) FROM oidc_trust_policies GROUP BY org_slug, issuer HAVING COUNT(DISTINCT tenant_id) > 1;
DROP INDEX "idx_oidc_trust_org_issuer";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oidc_trust_org_issuer" ON "oidc_trust_policies" USING btree ("org_slug","issuer");
