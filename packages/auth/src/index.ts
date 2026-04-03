// @procella/auth — Authentication via Descope JWT + dev mode token validation.
//
// Descope handles authn; tenant_id and roles from JWT drive authz.
// Dev mode uses a static token for local development.

import DescopeSdk from "@descope/node-sdk";
import { OidcClaims } from "@procella/oidc";
import { authAuthenticateDuration, authFailureCount, withSpan } from "@procella/telemetry";

import type { Caller, Role, WorkloadIdentity } from "@procella/types";
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
	createCliAccessKey?(
		caller: Caller,
		name: string,
		opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
	): Promise<string>;
	/** Stop background timers (e.g. cache sweep). Called on server shutdown. */
	dispose?(): void;
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
		return withSpan("procella.auth", "auth.authenticate", { "auth.mode": "dev" }, async () => {
			const start = performance.now();
			try {
				const { token } = extractToken(request);
				if (token !== this.config.token) {
					throw new UnauthorizedError("Invalid authentication token");
				}
				return {
					tenantId: this.config.orgLogin,
					orgSlug: this.config.orgLogin,
					userId: this.config.userLogin,
					login: this.config.userLogin,
					roles: ["admin"] as const,
					principalType: "user" as const,
				};
			} catch (error) {
				authFailureCount().add(1, { "auth.mode": "dev" });
				throw error;
			} finally {
				authAuthenticateDuration().record(performance.now() - start, { "auth.mode": "dev" });
			}
		});
	}

	async authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }> {
		return withSpan(
			"procella.auth",
			"auth.authenticateUpdateToken",
			{ "auth.mode": "dev" },
			async () => {
				const start = performance.now();
				try {
					return parseUpdateToken(token);
				} catch (error) {
					authFailureCount().add(1, { "auth.mode": "dev" });
					throw error;
				} finally {
					authAuthenticateDuration().record(performance.now() - start, { "auth.mode": "dev" });
				}
			},
		);
	}
}

// ============================================================================
// Descope Auth Service
// ============================================================================

export interface DescopeAuthConfig {
	projectId: string;
	managementKey?: string;
}

type DescopeClient = ReturnType<typeof DescopeSdk>;

/** Cached access-key → Caller mapping with TTL from JWT exp claim. */
interface CachedAuth {
	caller: Caller;
	/** Unix timestamp (seconds) — re-exchange when now >= expiresAt. */
	expiresAt: number;
}

export class DescopeAuthService implements AuthService {
	readonly sdk: DescopeClient;
	private readonly cache = new Map<string, CachedAuth>();
	private readonly pending = new Map<string, Promise<Caller>>();
	private readonly EXPIRY_MARGIN_S = 60;
	private readonly MAX_CACHE_TTL_S = 300;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(options: { sdk: DescopeClient; config: DescopeAuthConfig }) {
		this.sdk = options.sdk;
		this.sweepTimer = setInterval(() => this.sweep(), 60_000);
		if (this.sweepTimer.unref) this.sweepTimer.unref();
	}

	async authenticate(request: Request): Promise<Caller> {
		return withSpan("procella.auth", "auth.authenticate", { "auth.mode": "descope" }, async () => {
			const start = performance.now();
			try {
				const { scheme, token } = extractToken(request);

				// Block raw JWTs on the Pulumi CLI path — CLI should use access keys.
				// "token <value>" = CLI; "Bearer <value>" = UI dashboard (session JWTs OK there).
				if (scheme === "token" && token.startsWith("eyJ")) {
					throw new UnauthorizedError(
						"Session JWTs cannot be used as CLI tokens (they expire). Use `pulumi login` to create a long-lived access key.",
					);
				}

				// JWT tokens (Bearer from UI) — validate directly, no caching needed.
				if (token.startsWith("eyJ")) {
					const authInfo = await this.sdk.validateJwt(token);
					return this.extractCaller(authInfo.token);
				}

				// Access key tokens — cache the exchanged JWT.
				return this.authenticateAccessKey(token);
			} catch (error) {
				authFailureCount().add(1, { "auth.mode": "descope" });
				throw error;
			} finally {
				authAuthenticateDuration().record(performance.now() - start, { "auth.mode": "descope" });
			}
		});
	}

	async authenticateUpdateToken(token: string): Promise<{ updateId: string; stackId: string }> {
		return withSpan(
			"procella.auth",
			"auth.authenticateUpdateToken",
			{ "auth.mode": "descope" },
			async () => {
				const start = performance.now();
				try {
					return parseUpdateToken(token);
				} catch (error) {
					authFailureCount().add(1, { "auth.mode": "descope" });
					throw error;
				} finally {
					authAuthenticateDuration().record(performance.now() - start, {
						"auth.mode": "descope",
					});
				}
			},
		);
	}

	async createCliAccessKey(
		caller: Caller,
		name: string,
		opts?: { expireTime?: number; customClaims?: Record<string, unknown> },
	): Promise<string> {
		const start = performance.now();
		return withSpan(
			"procella.auth",
			"auth.createCliAccessKey",
			{ "auth.mode": "descope" },
			async () => {
				try {
					// Skip user lookup for workload principals — they have no Descope user.
					const u =
						caller.principalType !== "workload" && caller.userId
							? await this.sdk.management.user
									.loadByUserId(caller.userId)
									.then((r) => (r.ok ? r.data : undefined))
									.catch(() => undefined)
							: undefined;
					const loginId =
						u?.email ??
						u?.name ??
						(u?.givenName && u?.familyName ? `${u.givenName} ${u.familyName}` : undefined) ??
						u?.loginIds?.[0] ??
						caller.login; // use pre-computed login for workload callers
					const expireTime = opts?.expireTime ?? 0;
					// Ensure procellaLogin and procellaOrgSlug are never overridable by caller-provided customClaims
					const {
						procellaLogin: _a,
						procellaOrgSlug: _b,
						...safeCustomClaims
					} = opts?.customClaims ?? {};
					const customClaims = { procellaLogin: loginId, ...safeCustomClaims };

					const resp = await this.sdk.management.accessKey.create(
						name,
						expireTime,
						undefined,
						[{ tenantId: caller.tenantId, roleNames: [...caller.roles] }],
						caller.userId || undefined, // pass undefined for workload (empty string) to avoid Descope 33-char limit
						// biome-ignore lint/suspicious/noExplicitAny: Descope SDK types use Record<string, any>
						customClaims as Record<string, any>,
					);
					if (!resp.ok || !resp.data?.cleartext) {
						throw new Error(
							resp.error?.errorMessage ??
								resp.error?.errorDescription ??
								"Failed to create access key",
						);
					}
					return resp.data.cleartext;
				} catch (error) {
					authFailureCount().add(1, { "auth.mode": "descope" });
					throw error;
				} finally {
					authAuthenticateDuration().record(performance.now() - start, {
						"auth.mode": "descope",
					});
				}
			},
		);
	}

	/** Stop the sweep timer. Call on server shutdown. */
	dispose(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}

	// ---- Private: Cache ------------------------------------------------

	private async authenticateAccessKey(accessKey: string): Promise<Caller> {
		// 1. Check cache
		const cached = this.cache.get(accessKey);
		if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) {
			return cached.caller;
		}

		// 2. Deduplicate concurrent exchanges for the same key
		const inflight = this.pending.get(accessKey);
		if (inflight) {
			return inflight;
		}

		// 3. Exchange and cache
		const promise = this.doExchange(accessKey);
		this.pending.set(accessKey, promise);

		try {
			return await promise;
		} finally {
			this.pending.delete(accessKey);
		}
	}

	private async doExchange(accessKey: string): Promise<Caller> {
		const maxAttempts = 3;
		let lastErr: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const started = performance.now();
			try {
				const authInfo = await this.sdk.exchangeAccessKey(accessKey);
				const claims = authInfo.token;
				const elapsed = (performance.now() - started).toFixed(0);
				const exp = typeof claims.exp === "number" ? claims.exp : undefined;
				// biome-ignore lint/suspicious/noConsole: auth diagnostics
				console.log(
					`[auth] exchangeAccessKey OK ${elapsed}ms exp=${exp ? new Date(exp * 1000).toISOString() : "none"} sub=${claims.sub ?? "?"}`,
				);

				const caller = this.extractCaller(claims);

				if (exp) {
					const nowSec = Math.floor(Date.now() / 1000);
					const desiredExpiry = exp - this.EXPIRY_MARGIN_S;
					const cappedExpiry = Math.min(desiredExpiry, nowSec + this.MAX_CACHE_TTL_S);
					if (cappedExpiry > nowSec) {
						this.cache.set(accessKey, { caller, expiresAt: cappedExpiry });
					}
				}

				return caller;
			} catch (err) {
				const elapsed = (performance.now() - started).toFixed(0);
				lastErr = err;
				if (attempt < maxAttempts) {
					const delay = attempt * 500;
					// biome-ignore lint/suspicious/noConsole: auth retry diagnostics
					console.warn(
						`[auth] exchangeAccessKey attempt ${attempt}/${maxAttempts} failed after ${elapsed}ms, retrying in ${delay}ms: ${err}`,
					);
					await new Promise((r) => setTimeout(r, delay));
				} else {
					console.error(
						`[auth] exchangeAccessKey FAILED after ${attempt} attempt(s) ${elapsed}ms: ${err}`,
					);
				}
			}
		}
		throw lastErr;
	}

	private extractCaller(claims: Record<string, unknown>): Caller {
		const tenantId = extractTenantId(claims);
		if (!tenantId) {
			throw new UnauthorizedError("JWT missing tenant claim");
		}

		const userId = typeof claims.sub === "string" ? claims.sub : "";
		const login =
			typeof claims.procellaLogin === "string" && claims.procellaLogin
				? claims.procellaLogin
				: typeof claims.strataLogin === "string" && claims.strataLogin
					? claims.strataLogin
					: userId;
		const roles = extractRoles(claims, tenantId);
		const principalTypeRaw = claims[OidcClaims.principalType];
		const isWorkload = principalTypeRaw === "workload";

		const workload: WorkloadIdentity | undefined = isWorkload
			? {
					provider: String(claims[OidcClaims.workloadProvider] ?? ""),
					issuer: optionalString(claims[OidcClaims.workloadIssuer]) ?? "",
					subject: String(claims[OidcClaims.workloadSub] ?? ""),
					repository: optionalString(claims[OidcClaims.workloadRepo]),
					repositoryId: optionalString(claims[OidcClaims.workloadRepoId]),
					repositoryOwner: optionalString(claims[OidcClaims.workloadRepoOwner]),
					repositoryOwnerId: optionalString(claims[OidcClaims.workloadRepoOwnerId]),
					workflowRef: optionalString(claims[OidcClaims.workloadWorkflowRef]),
					environment: optionalString(claims[OidcClaims.workloadEnvironment]),
					ref: optionalString(claims[OidcClaims.workloadRef]),
					runId: optionalString(claims[OidcClaims.workloadRunId]),
					actor: optionalString(claims[OidcClaims.triggerActor]),
					actorId: optionalString(claims[OidcClaims.triggerActorId]),
					jti: optionalString(claims[OidcClaims.workloadJti]),
				}
			: undefined;

		return {
			tenantId,
			orgSlug: extractOrgSlug(claims, tenantId),
			userId,
			login,
			roles,
			principalType: isWorkload ? "workload" : userId.startsWith("token:") ? "token" : "user",
			workload,
		};
	}

	private sweep(): void {
		const now = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.cache) {
			if (entry.expiresAt <= now) {
				this.cache.delete(key);
			}
		}
	}
}

function optionalString(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined;
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
		case "descope": {
			const sdk = DescopeSdk({
				projectId: config.projectId,
				managementKey: config.managementKey,
			});
			return new DescopeAuthService({
				sdk,
				config: {
					projectId: config.projectId,
					managementKey: config.managementKey,
				},
			});
		}
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
function extractToken(request: Request): { scheme: "token" | "bearer"; token: string } {
	const header = request.headers.get("Authorization");
	if (!header) {
		throw new UnauthorizedError("Missing Authorization header");
	}

	// Pulumi CLI format: "token <value>"
	if (header.startsWith("token ")) {
		const value = header.slice(6).trim();
		if (!value) throw new UnauthorizedError("Empty token value");
		return { scheme: "token", token: value };
	}

	// Standard Bearer format: "Bearer <value>"
	if (header.startsWith("Bearer ")) {
		const value = header.slice(7).trim();
		if (!value) throw new UnauthorizedError("Empty Bearer token");
		return { scheme: "bearer", token: value };
	}

	throw new UnauthorizedError("Invalid Authorization header format");
}

/** Parse update token format: "update:<updateId>:<stackId>:<secret>" */
function parseUpdateToken(token: string): { updateId: string; stackId: string } {
	const parts = token.split(":");
	if (parts.length !== 4 || parts[0] !== "update" || !parts[1] || !parts[2] || !parts[3]) {
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

/**
 * Derive a URL-safe org slug from JWT claims.
 *
 * Resolution order:
 *   1. Explicit `procellaOrgSlug` claim (set by OIDC exchange — authoritative)
 *   2. Top-level `tenant_name` (present in session JWTs via Descope JWT Templates)
 *   3. Nested `tenants.<tenantId>.name` (present in CLI access key JWTs)
 *   4. Raw tenantId as last resort
 */
export function extractOrgSlug(claims: Record<string, unknown>, tenantId: string): string {
	// 1. Explicit orgSlug from OIDC workload claims (authoritative, set by trust policy)
	const explicit = claims[OidcClaims.orgSlug];
	if (typeof explicit === "string" && explicit) return explicit;

	// 2. Top-level tenant_name (present in session JWTs)
	const topLevel =
		typeof claims.tenant_name === "string" && claims.tenant_name ? claims.tenant_name : undefined;
	if (topLevel) return slugify(topLevel) || tenantId;

	// 3. Nested tenants.<id>.name (present in CLI access key JWTs)
	if (claims.tenants && typeof claims.tenants === "object") {
		const tenants = claims.tenants as Record<string, Record<string, unknown>>;
		const name = tenants[tenantId]?.name;
		if (typeof name === "string" && name) return slugify(name) || tenantId;
	}

	// 4. Last resort — should not happen if Descope is configured correctly
	return tenantId;
}

/** Convert a string to a URL-safe slug (lowercase, alphanumeric + hyphens). */
export function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-/, "")
		.replace(/-$/, "");
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
