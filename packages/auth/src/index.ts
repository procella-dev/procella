// @procella/auth — Authentication via Descope JWT + dev mode token validation.
//
// Descope handles authn; tenant_id and roles from JWT drive authz.
// Dev mode uses a static token for local development.

import DescopeSdk from "@descope/node-sdk";
import type { Caller, Role } from "@procella/types";
import { ForbiddenError, UnauthorizedError } from "@procella/types";

// ============================================================================
// Auth Service Interface
// ============================================================================

export interface AuthService {
	/** Authenticate a request, returning the Caller identity. */
	authenticate(request: Request): Promise<Caller>;
	/** Authenticate an update-token (lease token from StartUpdate). */
	authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }>;
	/** Create a long-lived CLI access key for the given caller. Returns the cleartext key. */
	createCliAccessKey?(caller: Caller, name: string): Promise<string>;
}

// ============================================================================
// Auth Config
// ============================================================================

export type AuthConfig =
	| { mode: "dev"; token: string; userLogin: string; orgLogin: string }
	| { mode: "descope"; projectId: string; managementKey?: string };

// ============================================================================
// Dev Auth Service
// ============================================================================

export interface DevAuthConfig {
	token: string;
	userLogin: string;
	orgLogin: string;
}

export class DevAuthService implements AuthService {
	private readonly config: DevAuthConfig;

	constructor(config: DevAuthConfig) {
		this.config = config;
	}

	async authenticate(request: Request): Promise<Caller> {
		const token = extractToken(request);
		if (token !== this.config.token) {
			throw new UnauthorizedError("Invalid authentication token");
		}
		return {
			tenantId: this.config.orgLogin,
			userId: this.config.userLogin,
			login: this.config.userLogin,
			roles: ["admin"] as const,
		};
	}

	async authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }> {
		return parseUpdateToken(token);
	}
}

// ============================================================================
// Descope Auth Service
// ============================================================================

export interface DescopeAuthConfig {
	projectId: string;
	managementKey?: string;
}

export class DescopeAuthService implements AuthService {
	private readonly sdk: ReturnType<typeof DescopeSdk>;

	constructor(config: DescopeAuthConfig) {
		this.sdk = DescopeSdk({ projectId: config.projectId, managementKey: config.managementKey });
	}

	async authenticate(request: Request): Promise<Caller> {
		const token = extractToken(request);

		const authInfo = token.startsWith("eyJ")
			? await this.sdk.validateJwt(token)
			: await this.sdk.exchangeAccessKey(token);
		const claims = authInfo.token;

		// Descope stores tenant ID in `dct` (descope current tenant) claim
		// or in tenants object. Access keys use `act` claim for tenant context.
		const tenantId = extractTenantId(claims);
		if (!tenantId) {
			throw new UnauthorizedError("JWT missing tenant claim");
		}

		const userId = claims.sub ?? "";
		const login =
			typeof claims.procellaLogin === "string" && claims.procellaLogin
				? claims.procellaLogin
				: typeof claims.strataLogin === "string" && claims.strataLogin
					? claims.strataLogin
					: userId;
		const roles = extractRoles(claims, tenantId);

		return {
			tenantId,
			userId,
			login,
			roles,
		};
	}

	async authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }> {
		return parseUpdateToken(token);
	}

	async createCliAccessKey(caller: Caller, name: string): Promise<string> {
		const userResp = await this.sdk.management.user.loadByUserId(caller.userId);
		const u = userResp.ok ? userResp.data : undefined;
		const loginId =
			u?.email ??
			u?.name ??
			(u?.givenName && u?.familyName ? `${u.givenName} ${u.familyName}` : undefined) ??
			u?.loginIds?.[0] ??
			caller.userId;

		const resp = await this.sdk.management.accessKey.create(
			name,
			0,
			undefined,
			[{ tenantId: caller.tenantId, roleNames: [...caller.roles] }],
			caller.userId,
			{ procellaLogin: loginId },
		);
		if (!resp.ok || !resp.data?.cleartext) {
			throw new Error(
				resp.error?.errorMessage ?? resp.error?.errorDescription ?? "Failed to create access key",
			);
		}
		return resp.data.cleartext;
	}
}

// ============================================================================
// Factory
// ============================================================================

export function createAuthService(config: AuthConfig): AuthService {
	switch (config.mode) {
		case "dev":
			return new DevAuthService({
				token: config.token,
				userLogin: config.userLogin,
				orgLogin: config.orgLogin,
			});
		case "descope":
			return new DescopeAuthService({
				projectId: config.projectId,
				managementKey: config.managementKey,
			});
	}
}

// ============================================================================
// Authorization Helpers
// ============================================================================

/** HTTP method → minimum role mapping for RBAC. */
export const METHOD_ROLE_MAP: Record<string, Role> = {
	GET: "viewer",
	HEAD: "viewer",
	POST: "member",
	PUT: "member",
	PATCH: "member",
	DELETE: "admin",
};

/** Check if caller has at least one of the required roles. Throws ForbiddenError if not. */
export function requireRole(caller: Caller, ...roles: Role[]): void {
	// Admin always passes
	if (caller.roles.includes("admin")) {
		return;
	}
	// Member passes for member or viewer checks
	if (caller.roles.includes("member") && roles.some((r) => r === "member" || r === "viewer")) {
		return;
	}
	// Viewer passes only for viewer checks
	if (caller.roles.includes("viewer") && roles.includes("viewer")) {
		return;
	}
	throw new ForbiddenError(`Caller ${caller.login} lacks required role: ${roles.join(", ")}`);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Extract bearer/token from Authorization header (supports Pulumi CLI + standard formats). */
function extractToken(request: Request): string {
	const header = request.headers.get("Authorization");
	if (!header) {
		throw new UnauthorizedError("Missing Authorization header");
	}

	// Pulumi CLI format: "token <value>"
	if (header.startsWith("token ")) {
		const value = header.slice(6).trim();
		if (!value) {
			throw new UnauthorizedError("Empty token value");
		}
		return value;
	}

	// Standard Bearer format: "Bearer <value>"
	if (header.startsWith("Bearer ")) {
		const value = header.slice(7).trim();
		if (!value) {
			throw new UnauthorizedError("Empty Bearer token");
		}
		return value;
	}

	throw new UnauthorizedError("Invalid Authorization header format");
}

/** Parse update token format: "update:<updateId>:<stackId>" */
function parseUpdateToken(token: string): { updateId: string; stackId: string } {
	const parts = token.split(":");
	if (parts.length !== 3 || parts[0] !== "update" || !parts[1] || !parts[2]) {
		throw new UnauthorizedError("Invalid update token format");
	}
	return { updateId: parts[1], stackId: parts[2] };
}

/** Extract tenant ID from Descope JWT claims. */
function extractTenantId(claims: Record<string, unknown>): string | undefined {
	// `dct` = Descope Current Tenant (set when authenticating with tenant context)
	if (typeof claims.dct === "string" && claims.dct) {
		return claims.dct;
	}

	// Fallback: look in tenants object for the first (and typically only) tenant
	if (claims.tenants && typeof claims.tenants === "object") {
		const tenantIds = Object.keys(claims.tenants as Record<string, unknown>);
		if (tenantIds.length > 0) {
			return tenantIds[0];
		}
	}

	return undefined;
}

/** Extract roles from Descope JWT claims for a specific tenant. */
function extractRoles(claims: Record<string, unknown>, tenantId: string): Role[] {
	const validRoles = new Set<string>(["admin", "member", "viewer"]);
	const roles: Role[] = [];

	// Descope puts per-tenant roles in: tenants.<tenantId>.roles
	if (claims.tenants && typeof claims.tenants === "object") {
		const tenants = claims.tenants as Record<string, Record<string, unknown>>;
		const tenantClaims = tenants[tenantId];
		if (tenantClaims?.roles && Array.isArray(tenantClaims.roles)) {
			for (const role of tenantClaims.roles) {
				if (typeof role === "string" && validRoles.has(role)) {
					roles.push(role as Role);
				}
			}
		}
	}

	// Fallback: top-level roles claim (for non-tenant-scoped JWTs)
	if (roles.length === 0 && Array.isArray(claims.roles)) {
		for (const role of claims.roles) {
			if (typeof role === "string" && validRoles.has(role)) {
				roles.push(role as Role);
			}
		}
	}

	// Default to viewer if no recognized roles found
	if (roles.length === 0) {
		roles.push("viewer");
	}

	return roles;
}
