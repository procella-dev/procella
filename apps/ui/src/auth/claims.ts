// Session-claims helpers — tenant/role extraction that works in BOTH token
// delivery modes. When Descope manages tokens in HttpOnly cookies, the session
// JWT is never visible to JS, but the SDK still exposes its claims via
// `useSession().claims`, so all RBAC/tenant derivation goes through claims
// instead of decoding the raw JWT.

export type SessionClaims = Record<string, unknown>;

/** Tenant ID from Descope session claims — `dct` (current tenant), falling back to a single `tenants` key. */
export function tenantFromClaims(claims: SessionClaims | null | undefined): string {
	if (!claims) return "";
	if (typeof claims.dct === "string" && claims.dct) return claims.dct;
	if (claims.tenants && typeof claims.tenants === "object") {
		const ids = Object.keys(claims.tenants as Record<string, unknown>);
		if (ids.length === 1) return ids[0];
	}
	return "";
}

/** Roles for a tenant from Descope session claims — tenant-scoped roles, falling back to top-level `roles`. */
export function rolesFromClaims(
	claims: SessionClaims | null | undefined,
	tenantId: string,
): string[] {
	if (!claims) return [];
	const tenants = claims.tenants as Record<string, { roles?: unknown }> | undefined;
	const tenantRoles = tenantId ? tenants?.[tenantId]?.roles : undefined;
	if (Array.isArray(tenantRoles)) {
		return tenantRoles.filter((r): r is string => typeof r === "string");
	}
	if (Array.isArray(claims.roles)) {
		return (claims.roles as unknown[]).filter((r): r is string => typeof r === "string");
	}
	return [];
}
