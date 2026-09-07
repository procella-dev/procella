// GitHub user identity verification backed by a Descope Outbound Application.
//
// The raw GitHub user token is vaulted in Descope. Procella fetches it
// server-side for the duration of one verification call and never persists,
// logs, or forwards it. Every failure mode collapses to "unavailable" so a
// broken management call can never be mistaken for a verified administrator.

import DescopeClient from "@descope/node-sdk";
import { Octokit } from "@octokit/rest";

export const GITHUB_OUTBOUND_REQUEST_TIMEOUT_MS = 8_000;

/** Vaulted GitHub user tokens for one outbound application. */
export interface GitHubOutboundTokenVault {
	/** Latest access token for the user, or null when none is vaulted. */
	fetchUserToken(userId: string): Promise<string | null>;
	/** Removes every vaulted token the user holds for the outbound app. */
	deleteUserTokens(userId: string): Promise<void>;
}

export interface GitHubUserIdentity {
	login: string;
}

/**
 * Verification surface the installation flow depends on. Implemented over the
 * vault plus GitHub's user-scoped API.
 */
export interface GitHubOutboundIdentityService {
	/** Connected GitHub login for the user, or null when no usable token exists. */
	loadIdentity(userId: string): Promise<GitHubUserIdentity | null>;
	/**
	 * Resolves when the user owns `accountLogin` or is an active organization
	 * administrator of it. Rejects with the reason otherwise.
	 */
	verifyAccountAdministration(userId: string, accountLogin: string): Promise<void>;
	/** Resolves when the installation is visible to the connected user. */
	verifyInstallationAccess(userId: string, installationId: number): Promise<void>;
	/** Deletes the user's vaulted GitHub token. */
	disconnect(userId: string): Promise<void>;
}

export type GitHubOutboundErrorCode = "authorization_required" | "authorization_failed";

export class GitHubOutboundError extends Error {
	constructor(readonly code: GitHubOutboundErrorCode) {
		super(code);
		this.name = "GitHubOutboundError";
	}
}

/**
 * The two Descope outbound-application calls this integration makes. Declared
 * locally so tests and the runtime share one narrow contract instead of the
 * whole management SDK surface.
 */
export interface DescopeOutboundApplicationApi {
	fetchToken(
		appId: string,
		userId: string,
		tenantId: undefined,
		options: { forceRefresh: boolean },
	): Promise<{ ok: boolean; data?: { accessToken?: string } }>;
	deleteUserTokens(appId: string, userId: string): Promise<{ ok: boolean }>;
}

/** Narrow adapter over Descope's outbound-application management API. */
export class DescopeGitHubOutboundVault implements GitHubOutboundTokenVault {
	constructor(
		private readonly outboundApplication: DescopeOutboundApplicationApi,
		private readonly appId: string,
	) {}

	async fetchUserToken(userId: string): Promise<string | null> {
		const response = await this.outboundApplication
			.fetchToken(this.appId, userId, undefined, { forceRefresh: false })
			.catch(() => null);
		const accessToken = response?.ok ? response.data?.accessToken : undefined;
		return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : null;
	}

	async deleteUserTokens(userId: string): Promise<void> {
		const response = await this.outboundApplication
			.deleteUserTokens(this.appId, userId)
			.catch(() => null);
		if (!response?.ok) {
			throw new GitHubOutboundError("authorization_failed");
		}
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
	return new DescopeGitHubOutboundVault(sdk.management.outboundApplication, options.appId);
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
 */
export class VaultedGitHubIdentityService implements GitHubOutboundIdentityService {
	private readonly userClientFactory: (token: string) => Octokit;

	constructor(
		private readonly vault: GitHubOutboundTokenVault,
		userClientFactory?: (token: string) => Octokit,
	) {
		this.userClientFactory = userClientFactory ?? ((token) => new Octokit({ auth: token }));
	}

	async loadIdentity(userId: string): Promise<GitHubUserIdentity | null> {
		const token = await this.vault.fetchUserToken(userId).catch(() => null);
		if (!token) return null;
		try {
			return { login: await this.currentLogin(token) };
		} catch {
			return null;
		}
	}

	async verifyAccountAdministration(userId: string, accountLogin: string): Promise<void> {
		const token = await this.requireToken(userId);
		const login = await this.currentLogin(token);
		if (login.toLowerCase() === accountLogin.toLowerCase()) return;

		const client = this.userClientFactory(token);
		try {
			const { data: membership } = await client.request("GET /user/memberships/orgs/{org}", {
				org: accountLogin,
				...this.requestOptions(),
			});
			if (membership.state === "active" && membership.role === "admin") return;
		} catch (error) {
			if (githubErrorStatus(error) !== 404) {
				throw new GitHubOutboundError("authorization_failed");
			}
		}
		throw new GitHubOutboundError("authorization_required");
	}

	async verifyInstallationAccess(userId: string, installationId: number): Promise<void> {
		const token = await this.requireToken(userId);
		const client = this.userClientFactory(token);
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

	async disconnect(userId: string): Promise<void> {
		await this.vault.deleteUserTokens(userId);
	}

	private async requireToken(userId: string): Promise<string> {
		const token = await this.vault.fetchUserToken(userId).catch(() => {
			throw new GitHubOutboundError("authorization_failed");
		});
		if (!token) throw new GitHubOutboundError("authorization_required");
		return token;
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
