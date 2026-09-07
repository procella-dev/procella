// GitHub user identity verification backed by a Descope Outbound Application.
//
// The raw GitHub user token is vaulted in Descope. Procella fetches it
// server-side for the duration of one verification call and never persists,
// logs, or forwards it. Every failure mode collapses to "unavailable" so a
// broken management call can never be mistaken for a verified administrator.
//
// Every call is tenant scoped. Descope vaults the token against
// (app, user, tenant), so the same Descope user connecting from two Procella
// tenants holds two independent tokens and neither tenant can read, use, or
// delete the other's.

import DescopeClient from "@descope/node-sdk";
import { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import { githubOutboundConnections } from "@procella/db";
import { and, eq } from "drizzle-orm";

export const GITHUB_OUTBOUND_REQUEST_TIMEOUT_MS = 8_000;

export interface GitHubVaultedToken {
	/** Descope token id, used for confirmation matching and tenant-scoped deletion. */
	id: string;
	accessToken: string;
}

/**
 * Outcome of a vault lookup. `absent` is Descope answering that this tenant has
 * no token; `failed` is Descope not answering at all. Collapsing the two would
 * let an outage look like a completed disconnect.
 */
export type GitHubVaultedTokenLookup =
	| { readonly outcome: "found"; readonly token: GitHubVaultedToken }
	| { readonly outcome: "absent" }
	| { readonly outcome: "failed" };

/** Vaulted GitHub user tokens for one outbound application, per tenant. */
export interface GitHubOutboundTokenVault {
	/** Looks up the latest tenant-scoped token for the user. */
	fetchUserToken(userId: string, tenantId: string): Promise<GitHubVaultedTokenLookup>;
	/** Deletes exactly one vaulted token by its Descope id. */
	deleteToken(tokenId: string): Promise<void>;
}

/**
 * Durable record that one tenant-scoped Descope token completed Procella's
 * browser-bound connect callback.
 *
 * Descope vaults a token the moment GitHub authorizes, which a forwarded
 * connect URL can trigger for a different GitHub user. The confirmed id read
 * from PostgreSQL is therefore the authority for using a token at all: an
 * unconfirmed or replaced token is neither observable nor usable.
 */
export interface GitHubOutboundConfirmations {
	confirmedTokenId(tenantId: string, userId: string): Promise<string | null>;
}

export interface GitHubUserIdentity {
	login: string;
}

/** Identity plus the Descope token id the callback is about to confirm. */
export interface GitHubPendingConnection extends GitHubUserIdentity {
	tokenId: string;
}

/**
 * Verification surface the installation flow depends on. Implemented over the
 * vault plus GitHub's user-scoped API.
 */
export interface GitHubOutboundIdentityService {
	/** Connected GitHub login for a confirmed tenant connection, or null. */
	loadIdentity(userId: string, tenantId: string): Promise<GitHubUserIdentity | null>;
	/**
	 * Reads the tenant-scoped token the browser-bound callback is about to
	 * confirm, returning its Descope id and GitHub identity. This is the only
	 * ungated entry point, and its result stays unusable until the caller
	 * durably records that id.
	 */
	loadPendingConnection(userId: string, tenantId: string): Promise<GitHubPendingConnection>;
	/**
	 * Resolves when the confirmed connected user owns `accountLogin` or is an
	 * active organization administrator of it.
	 *
	 * `allowInvisibleMembership` covers the pre-installation leg: the vaulted
	 * token is a GitHub App user-to-server token, so organization membership is
	 * unreadable until the App is installed on that organization. The
	 * post-installation call leaves it off and therefore requires proof.
	 */
	verifyAccountAdministration(
		userId: string,
		tenantId: string,
		accountLogin: string,
		options?: { allowInvisibleMembership?: boolean },
	): Promise<void>;
	/** Resolves when the installation is visible to the confirmed connected user. */
	verifyInstallationAccess(userId: string, tenantId: string, installationId: number): Promise<void>;
	/** Deletes this tenant's confirmed GitHub token, leaving other tenants intact. */
	disconnect(userId: string, tenantId: string): Promise<void>;
}

export type GitHubOutboundErrorCode = "authorization_required" | "authorization_failed";

export class GitHubOutboundError extends Error {
	constructor(readonly code: GitHubOutboundErrorCode) {
		super(code);
		this.name = "GitHubOutboundError";
	}
}

/**
 * The Descope outbound-application calls this integration makes. Declared
 * locally so tests and the runtime share one narrow contract instead of the
 * whole management SDK surface.
 *
 * `deleteUserTokens` is deliberately absent: it removes every token for the
 * app and user across all tenants, which would break tenant isolation on
 * disconnect. Deletion goes through `deleteTokenById` for the token this
 * tenant owns.
 */
export interface DescopeOutboundApplicationApi {
	fetchToken(
		appId: string,
		userId: string,
		tenantId: string,
		options: { forceRefresh: boolean },
	): Promise<{
		ok: boolean;
		code?: number;
		data?: { id?: string; accessToken?: string; tenantId?: string };
	}>;
	deleteTokenById(id: string): Promise<{ ok: boolean; code?: number }>;
}

/** Descope's documented "no such token" answer. Anything else is inconclusive. */
const DESCOPE_NOT_FOUND = 404;

/** Narrow adapter over Descope's outbound-application management API. */
export class DescopeGitHubOutboundVault implements GitHubOutboundTokenVault {
	constructor(
		private readonly outboundApplication: DescopeOutboundApplicationApi,
		private readonly appId: string,
	) {}

	async fetchUserToken(userId: string, tenantId: string): Promise<GitHubVaultedTokenLookup> {
		const response = await this.outboundApplication
			.fetchToken(this.appId, userId, tenantId, { forceRefresh: false })
			.catch(() => null);
		// Absence is only ever Descope's documented not-found. A thrown call or any
		// other rejection leaves the credential state unknown.
		if (!response) return { outcome: "failed" };
		if (!response.ok) {
			return response.code === DESCOPE_NOT_FOUND ? { outcome: "absent" } : { outcome: "failed" };
		}

		const token = response.data;
		// A success that carries no usable token, or one Descope attributes to
		// another tenant, is not proof the vault is empty: report failure so no
		// caller cleans up local state on it.
		if (
			!token ||
			typeof token.accessToken !== "string" ||
			token.accessToken.length === 0 ||
			typeof token.id !== "string" ||
			token.id.length === 0 ||
			(typeof token.tenantId === "string" && token.tenantId !== tenantId)
		) {
			return { outcome: "failed" };
		}
		return { outcome: "found", token: { id: token.id, accessToken: token.accessToken } };
	}

	/** Resolves when the token is gone: deleted now, or already not found. */
	async deleteToken(tokenId: string): Promise<void> {
		const response = await this.outboundApplication.deleteTokenById(tokenId).catch(() => null);
		if (response?.ok || response?.code === DESCOPE_NOT_FOUND) return;
		throw new GitHubOutboundError("authorization_failed");
	}
}

export function createDescopeGitHubOutboundVault(options: {
	projectId: string;
	managementKey: string;
	appId: string;
}): GitHubOutboundTokenVault {
	const sdk = DescopeClient({
		projectId: options.projectId,
		managementKey: options.managementKey,
	});
	return new DescopeGitHubOutboundVault(
		sdk.management.outboundApplication as unknown as DescopeOutboundApplicationApi,
		options.appId,
	);
}

/** Confirmed-connection reads. Writes stay with the setup flow's transactions. */
export class PostgresGitHubOutboundConfirmations implements GitHubOutboundConfirmations {
	constructor(private readonly db: Database) {}

	async confirmedTokenId(tenantId: string, userId: string): Promise<string | null> {
		const [row] = await this.db
			.select({ tokenId: githubOutboundConnections.tokenId })
			.from(githubOutboundConnections)
			.where(
				and(
					eq(githubOutboundConnections.tenantId, tenantId),
					eq(githubOutboundConnections.userId, userId),
				),
			)
			.limit(1);
		return row?.tokenId ?? null;
	}
}

function githubErrorStatus(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null && "status" in error) {
		return typeof error.status === "number" ? error.status : undefined;
	}
	return undefined;
}

/**
 * Verifies GitHub account administration through the vaulted user token. The
 * token stays inside this class: callers only ever learn the connected login.
 *
 * Every read requires the current tenant-scoped token's Descope id to equal the
 * confirmed id in PostgreSQL, so a token vaulted by a forwarded connect URL, or
 * a later token that replaced the confirmed one, is unusable and invisible.
 */
export class VaultedGitHubIdentityService implements GitHubOutboundIdentityService {
	private readonly userClientFactory: (token: string) => Octokit;

	constructor(
		private readonly vault: GitHubOutboundTokenVault,
		private readonly confirmations: GitHubOutboundConfirmations,
		userClientFactory?: (token: string) => Octokit,
	) {
		this.userClientFactory = userClientFactory ?? ((token) => new Octokit({ auth: token }));
	}

	async loadIdentity(userId: string, tenantId: string): Promise<GitHubUserIdentity | null> {
		const token = await this.confirmedToken(userId, tenantId).catch(() => null);
		if (!token) return null;
		try {
			return { login: await this.currentLogin(token.accessToken) };
		} catch {
			return null;
		}
	}

	async loadPendingConnection(userId: string, tenantId: string): Promise<GitHubPendingConnection> {
		const token = await this.requireToken(userId, tenantId);
		return { tokenId: token.id, login: await this.currentLogin(token.accessToken) };
	}

	async verifyAccountAdministration(
		userId: string,
		tenantId: string,
		accountLogin: string,
		options: { allowInvisibleMembership?: boolean } = {},
	): Promise<void> {
		const token = await this.confirmedToken(userId, tenantId);
		const login = await this.currentLogin(token.accessToken);
		if (login.toLowerCase() === accountLogin.toLowerCase()) return;

		const client = this.userClientFactory(token.accessToken);
		try {
			const { data: membership } = await client.request("GET /user/memberships/orgs/{org}", {
				org: accountLogin,
				...this.requestOptions(),
			});
			if (membership.state === "active" && membership.role === "admin") return;
			throw new GitHubOutboundError("authorization_required");
		} catch (error) {
			if (error instanceof GitHubOutboundError) throw error;
			const status = githubErrorStatus(error);
			// 403/404 means the App cannot see this organization yet. Before
			// installation that is expected; afterwards it is a denial.
			if (status === 403 || status === 404) {
				if (options.allowInvisibleMembership) return;
				throw new GitHubOutboundError("authorization_required");
			}
			throw new GitHubOutboundError("authorization_failed");
		}
	}

	async verifyInstallationAccess(
		userId: string,
		tenantId: string,
		installationId: number,
	): Promise<void> {
		const token = await this.confirmedToken(userId, tenantId);
		const client = this.userClientFactory(token.accessToken);
		let page = 1;
		try {
			while (true) {
				const { data } = await client.request("GET /user/installations", {
					per_page: 100,
					page,
					...this.requestOptions(),
				});
				if (data.installations.some((installation) => installation.id === installationId)) {
					return;
				}
				if (page * 100 >= data.total_count) break;
				page += 1;
			}
		} catch {
			throw new GitHubOutboundError("authorization_failed");
		}
		throw new GitHubOutboundError("authorization_required");
	}

	/**
	 * Empties this tenant's slot in the vault before any local state is removed.
	 *
	 * The token Descope holds now is not necessarily the confirmed one: an
	 * abandoned or forwarded connect can have replaced confirmed token A with an
	 * unconfirmed token B. Deleting only A would leave B live in the vault while
	 * Procella reported a completed disconnect, so both the current and the
	 * confirmed token are deleted. Descope's documented not-found is the only
	 * accepted proof that a token is already gone; anything else fails closed and
	 * keeps the confirmation row and tenant binding in place.
	 */
	async disconnect(userId: string, tenantId: string): Promise<void> {
		const confirmedTokenId = await this.confirmations
			.confirmedTokenId(tenantId, userId)
			.catch(() => {
				throw new GitHubOutboundError("authorization_failed");
			});

		const lookup = await this.vault
			.fetchUserToken(userId, tenantId)
			.catch((): GitHubVaultedTokenLookup => ({ outcome: "failed" }));
		if (lookup.outcome === "failed") throw new GitHubOutboundError("authorization_failed");

		const doomed = new Set<string>();
		if (lookup.outcome === "found") doomed.add(lookup.token.id);
		if (confirmedTokenId) doomed.add(confirmedTokenId);
		for (const tokenId of doomed) {
			await this.vault.deleteToken(tokenId);
		}
	}

	/** The tenant's token, but only when Descope still reports the confirmed id. */
	private async confirmedToken(userId: string, tenantId: string): Promise<GitHubVaultedToken> {
		const confirmedTokenId = await this.confirmations
			.confirmedTokenId(tenantId, userId)
			.catch(() => {
				throw new GitHubOutboundError("authorization_failed");
			});
		if (!confirmedTokenId) throw new GitHubOutboundError("authorization_required");
		const token = await this.requireToken(userId, tenantId);
		if (token.id !== confirmedTokenId) {
			// A different token now sits in the vault: either a forwarded connect
			// URL created one, or the confirmed token was replaced. Neither passed
			// this browser's callback, so neither may be used.
			throw new GitHubOutboundError("authorization_required");
		}
		return token;
	}

	private async requireToken(userId: string, tenantId: string): Promise<GitHubVaultedToken> {
		const lookup = await this.vault
			.fetchUserToken(userId, tenantId)
			.catch((): GitHubVaultedTokenLookup => ({ outcome: "failed" }));
		if (lookup.outcome === "failed") throw new GitHubOutboundError("authorization_failed");
		if (lookup.outcome === "absent") throw new GitHubOutboundError("authorization_required");
		return lookup.token;
	}

	private async currentLogin(token: string): Promise<string> {
		try {
			const { data } = await this.userClientFactory(token).request(
				"GET /user",
				this.requestOptions(),
			);
			if (typeof data.login !== "string" || data.login.length === 0) {
				throw new GitHubOutboundError("authorization_failed");
			}
			return data.login;
		} catch (error) {
			if (error instanceof GitHubOutboundError) throw error;
			throw new GitHubOutboundError("authorization_failed");
		}
	}

	private requestOptions(): { request: { signal: AbortSignal } } {
		return { request: { signal: AbortSignal.timeout(GITHUB_OUTBOUND_REQUEST_TIMEOUT_MS) } };
	}
}
