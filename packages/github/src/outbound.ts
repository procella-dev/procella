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

/**
 * Hard ceiling on disconnect's drain loop. Reaching it means Descope kept
 * reporting new tokens, which is a failure rather than a completed disconnect.
 */
export const GITHUB_OUTBOUND_DRAIN_LIMIT = 16;

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

export interface GitHubAccountCandidate {
	login: string;
	accountType: "Organization" | "User";
}

/** One App installation visible to the confirmed connection's GitHub user. */
export interface GitHubVisibleInstallation {
	installationId: number;
	accountLogin: string;
	accountType: "Organization" | "User";
	repositorySelection: "all" | "selected";
}

/** Both listings the connect flow needs, read from one confirmed token. */
export interface GitHubConnectCandidates {
	administered: GitHubAccountCandidate[];
	installations: GitHubVisibleInstallation[];
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
	 * Everything the connect list needs, resolved from a single confirmed
	 * token: the accounts this connection administers (its own login plus
	 * every organization where it is an active admin) and every App
	 * installation it can see.
	 *
	 * The two listings answer different questions and are both required:
	 * administration comes from GitHub's user-scoped membership API, which
	 * needs no App permission and therefore also reports organizations the
	 * App is not installed on yet, while visibility comes from the App's own
	 * installation list. They are resolved together so one settings render
	 * costs one vault lookup instead of two.
	 */
	listConnectCandidates(userId: string, tenantId: string): Promise<GitHubConnectCandidates>;
	/**
	 * Resolves when the confirmed connected user owns `accountLogin` or is an
	 * active organization administrator of it.
	 *
	 * `confirmedTokenId` is the connection id the caller already read under the
	 * per-connection advisory lock. This method never reads the confirmation
	 * table itself: doing so would need a second pooled database connection
	 * while the caller's transaction holds the only one the pool has to give,
	 * self-deadlocking under a small pool. The caller is responsible for
	 * reading it inside that same transaction.
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
		confirmedTokenId: string | null,
		options?: { allowInvisibleMembership?: boolean },
	): Promise<void>;
	/**
	 * Resolves when the installation is visible to the confirmed connected user.
	 * `confirmedTokenId` carries the same no-second-connection requirement as
	 * {@link verifyAccountAdministration}.
	 */
	verifyInstallationAccess(
		userId: string,
		tenantId: string,
		installationId: number,
		confirmedTokenId: string | null,
	): Promise<void>;
	/**
	 * Empties this tenant's vault slot, leaving other tenants intact, and returns
	 * the token ids proven gone.
	 *
	 * `expectedTokenId` is the confirmation the caller read while holding the
	 * per-connection lock, so a confirmed token Descope never reports is cleared
	 * too. Callers must hold that lock: draining without it can race a concurrent
	 * confirmation into referencing a token this call deletes.
	 */
	drainTenantTokens(
		userId: string,
		tenantId: string,
		expectedTokenId: string | null,
	): Promise<readonly string[]>;
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

	async listConnectCandidates(userId: string, tenantId: string): Promise<GitHubConnectCandidates> {
		const token = await this.confirmedToken(userId, tenantId);
		const client = this.userClientFactory(token.accessToken);
		const [ownLogin, organizations, installations] = await Promise.all([
			this.currentLogin(token.accessToken, client),
			this.administeredOrganizations(client),
			this.visibleInstallations(client),
		]);
		return {
			administered: [{ login: ownLogin, accountType: "User" }, ...organizations],
			installations,
		};
	}

	private async administeredOrganizations(client: Octokit): Promise<GitHubAccountCandidate[]> {
		const organizations: GitHubAccountCandidate[] = [];
		let page = 1;
		try {
			while (true) {
				const { data } = await client.request("GET /user/memberships/orgs", {
					state: "active",
					per_page: 100,
					page,
					...this.requestOptions(),
				});
				for (const membership of data) {
					// `state` is requested as active, but a pending invitation is not
					// administration: it is re-checked here so a dropped or ignored
					// query parameter cannot list an organization the user has not
					// joined. Matches the per-account check below.
					if (membership.state === "active" && membership.role === "admin") {
						organizations.push({
							login: membership.organization.login,
							accountType: "Organization",
						});
					}
				}
				// This endpoint reports no total count, so a short page is the only
				// signal that pagination is done.
				if (data.length < 100) break;
				page += 1;
			}
		} catch (error) {
			if (error instanceof GitHubOutboundError) throw error;
			throw new GitHubOutboundError("authorization_failed");
		}
		organizations.sort((left, right) =>
			left.login.localeCompare(right.login, undefined, { sensitivity: "base" }),
		);
		return organizations;
	}

	private async visibleInstallations(client: Octokit): Promise<GitHubVisibleInstallation[]> {
		const visible: GitHubVisibleInstallation[] = [];
		let page = 1;
		try {
			while (true) {
				const { data } = await client.request("GET /user/installations", {
					per_page: 100,
					page,
					...this.requestOptions(),
				});
				for (const installation of data.installations) {
					const account = installation.account;
					const accountLogin =
						typeof account === "object" && account && "login" in account
							? account.login
							: undefined;
					const accountType = installation.target_type;
					const repositorySelection = installation.repository_selection;
					if (
						typeof accountLogin !== "string" ||
						(accountType !== "Organization" && accountType !== "User") ||
						(repositorySelection !== "all" && repositorySelection !== "selected")
					) {
						continue;
					}
					visible.push({
						installationId: installation.id,
						accountLogin,
						accountType,
						repositorySelection,
					});
				}
				// Termination depends on data actually received as well as the
				// reported count: a short page, or a total that disagrees with the
				// items returned, would otherwise re-request the same page forever
				// and re-append its installations.
				if (data.installations.length < 100 || page * 100 >= data.total_count) break;
				page += 1;
			}
		} catch (error) {
			if (error instanceof GitHubOutboundError) throw error;
			throw new GitHubOutboundError("authorization_failed");
		}
		return visible;
	}

	async verifyAccountAdministration(
		userId: string,
		tenantId: string,
		accountLogin: string,
		confirmedTokenId: string | null,
		options: { allowInvisibleMembership?: boolean } = {},
	): Promise<void> {
		const token = await this.tokenForConfirmedId(userId, tenantId, confirmedTokenId);
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
		confirmedTokenId: string | null,
	): Promise<void> {
		const token = await this.tokenForConfirmedId(userId, tenantId, confirmedTokenId);
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
	 * Drains this tenant's slot in the vault, returning the token ids proven gone.
	 *
	 * Descope can hold more than one token for a user, and the one it reports as
	 * latest is not necessarily the confirmed one: an abandoned or forwarded
	 * connect leaves extra tokens behind. Deleting only the latest and the
	 * confirmed id could therefore leave an older unconfirmed token live while
	 * Procella reported a completed disconnect. The loop instead deletes whatever
	 * Descope reports until Descope answers with its documented not-found.
	 *
	 * Everything else fails closed, so the caller keeps the confirmation row and
	 * tenant binding: an unanswered lookup or delete, a malformed answer, a token
	 * that reappears after a claimed delete, and a vault that still reports a new
	 * token once the deletion cap is spent. The cap bounds deletions, not
	 * lookups: one lookup runs past it so a slot that really is empty after the
	 * last permitted delete reports a completed drain instead of a failure.
	 */
	async drainTenantTokens(
		userId: string,
		tenantId: string,
		expectedTokenId: string | null,
	): Promise<readonly string[]> {
		const cleared = new Set<string>();
		for (let deletions = 0; ; deletions += 1) {
			const lookup = await this.vault
				.fetchUserToken(userId, tenantId)
				.catch((): GitHubVaultedTokenLookup => ({ outcome: "failed" }));
			if (lookup.outcome === "failed") throw new GitHubOutboundError("authorization_failed");
			if (lookup.outcome === "absent") {
				// The slot is provably empty. A confirmed id Descope never reported
				// is cleared too, tolerating its documented not-found.
				if (expectedTokenId && !cleared.has(expectedTokenId)) {
					await this.vault.deleteToken(expectedTokenId);
					cleared.add(expectedTokenId);
				}
				return [...cleared];
			}
			if (cleared.has(lookup.token.id)) {
				// Descope still reports a token this call already deleted, so the
				// vault state is unknown rather than empty.
				throw new GitHubOutboundError("authorization_failed");
			}
			if (deletions === GITHUB_OUTBOUND_DRAIN_LIMIT) {
				// The cap is spent and the vault answers with yet another token, so
				// the slot is not empty and no further deletion is allowed.
				throw new GitHubOutboundError("authorization_failed");
			}
			await this.vault.deleteToken(lookup.token.id);
			cleared.add(lookup.token.id);
		}
	}

	/**
	 * The tenant's token, but only when Descope still reports the confirmed id
	 * read from PostgreSQL. Used by {@link loadIdentity} and the listing
	 * methods, none of which run inside a caller's locked transaction — every
	 * verification method already knows the confirmed id from the transaction
	 * that is verifying it and must use {@link tokenForConfirmedId} instead, so
	 * it never opens a second pooled connection while that transaction holds
	 * the only one available.
	 */
	private async confirmedToken(userId: string, tenantId: string): Promise<GitHubVaultedToken> {
		const confirmedTokenId = await this.confirmations
			.confirmedTokenId(tenantId, userId)
			.catch(() => {
				throw new GitHubOutboundError("authorization_failed");
			});
		return this.tokenForConfirmedId(userId, tenantId, confirmedTokenId);
	}

	/**
	 * The vault's current token for this tenant, but only if it matches the id
	 * the caller already confirmed. Takes no database dependency: the caller
	 * supplies the confirmed id, typically read inside the same locked
	 * transaction that is about to consume the verification result.
	 */
	private async tokenForConfirmedId(
		userId: string,
		tenantId: string,
		confirmedTokenId: string | null,
	): Promise<GitHubVaultedToken> {
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

	/** Reuses `client` when the caller already built one for this token. */
	private async currentLogin(token: string, client?: Octokit): Promise<string> {
		try {
			const { data } = await (client ?? this.userClientFactory(token)).request(
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
