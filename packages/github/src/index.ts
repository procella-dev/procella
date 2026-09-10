import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import {
	githubInstallations,
	githubOutboundConnections,
	githubSetupStates,
	githubUpdateOutbox,
	updates,
} from "@procella/db";
import { projectError } from "@procella/types";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import {
	type GitHubConnectCandidates,
	GitHubOutboundError,
	type GitHubOutboundIdentityService,
	type GitHubPendingConnection,
	type GitHubUserIdentity,
} from "./outbound.js";

export * from "./outbound.js";

/** Outbound verification failures reach setup callers as setup error codes. */
function setupErrorFromOutbound(error: unknown): GitHubSetupError {
	if (error instanceof GitHubOutboundError) {
		return new GitHubSetupError(
			error.code === "authorization_required" ? "authorization_required" : "authorization_failed",
		);
	}
	return new GitHubSetupError("authorization_failed");
}

export interface GitHubInstallationData {
	installationId: number;
	accountLogin: string;
	accountType: "Organization" | "User";
	repositorySelection: "all" | "selected";
}

export interface GitHubInstallationInfo extends GitHubInstallationData {
	id: string;
	tenantId: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface GitHubInstallationRepository {
	id: number;
	name: string;
	fullName: string;
	ownerId: number;
	ownerLogin: string;
	private: boolean;
}

export interface GitHubAppConfig {
	appId: string;
	privateKey: string;
	webhookSecret: string;
	stateSigningKey: string;
	/** Descope Outbound Application that vaults each admin's GitHub user token. */
	outboundAppId: string;
}

export interface GitHubDeliveryConfig {
	appId: string;
	privateKey: string;
}

export interface GitHubRepositoryTarget {
	tenantId: string;
	owner: string;
	repo: string;
}

export interface GitHubDeliveryRequestOptions {
	deadlineMs?: number;
}

export interface GitHubDeliveryService {
	resolveInstallation(
		target: GitHubRepositoryTarget,
		options?: GitHubDeliveryRequestOptions,
	): Promise<GitHubInstallationInfo | null>;
	createPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<number>;
	findPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		marker: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<number | null>;
	updatePRComment(
		installationId: number,
		owner: string,
		repo: string,
		commentId: number,
		body: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<void>;
	setCommitStatus(
		installationId: number,
		owner: string,
		repo: string,
		sha: string,
		state: "pending" | "success" | "failure" | "error",
		description: string,
		context?: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<void>;
}

export interface GitHubConnectTarget {
	accountLogin: string;
	accountType: "Organization" | "User";
	/** Installation of this App on the account, when GitHub reports one. */
	installationId: number | null;
	/** Already bound to the calling tenant. */
	connected: boolean;
	/** Installed and bound to a different tenant, so this tenant cannot claim it. */
	claimedByOtherTenant: boolean;
}

export interface GitHubService extends GitHubDeliveryService {
	handleWebhookEvent(event: string, payload: unknown): Promise<void>;
	/** True when vaulted GitHub identity verification is wired up. */
	readonly connectAvailable: boolean;
	/** Connected GitHub login for the caller in this tenant, or null when nothing is vaulted. */
	resolveConnectedLogin(tenantId: string, userId: string): Promise<string | null>;
	/**
	 * Opens a one-time connect transaction bound to the tenant, the initiating
	 * admin, and the initiating browser. The returned signed state must travel
	 * in the Descope redirect URL so a forwarded authorization link cannot
	 * vault a stranger's token against this caller. No account is named yet:
	 * which accounts the caller administers is only knowable after GitHub
	 * authorizes and {@link confirmConnect} has run.
	 */
	beginConnect(tenantId: string, initiatorUserId: string, browserNonce: string): Promise<string>;
	/**
	 * Consumes the connect transaction and durably confirms the vaulted token,
	 * so it becomes usable at all, then returns the connected GitHub login.
	 */
	confirmConnect(
		connectState: string,
		browserNonce: string,
		initiator: { tenantId: string; userId: string },
	): Promise<GitHubUserIdentity>;
	/**
	 * Accounts the confirmed connection administers, joined against the App
	 * installations it can see, so the caller can offer Connect (already
	 * installed) or Install (fresh install) per account. Requires a confirmed
	 * connection.
	 */
	listConnectTargets(tenantId: string, userId: string): Promise<GitHubConnectTarget[]>;
	/**
	 * Binds an installation the confirmed connection already administers and
	 * can see, for the case where the App is already installed on the account.
	 */
	connectInstallation(
		tenantId: string,
		userId: string,
		installationId: number,
	): Promise<GitHubInstallationInfo>;
	/**
	 * Issues browser-bound installation state for a fresh install of the App.
	 * With an account, administration of it is verified up front. Without one,
	 * GitHub's installation picker chooses the account, which is the only way
	 * to reach an organization the connect list cannot enumerate, and
	 * {@link completeInstallation} authorizes whatever comes back.
	 */
	issueInstallationUrl(
		tenantId: string,
		userId: string,
		accountLogin: string | undefined,
		browserNonce: string,
	): Promise<string>;
	completeInstallation(
		state: string,
		installationId: number,
		browserNonce: string,
	): Promise<GitHubInstallationInfo>;
	listInstallations(tenantId: string): Promise<GitHubInstallationInfo[]>;
	/** Repositories currently visible to an installation bound to this tenant. */
	listInstallationRepositories(
		tenantId: string,
		installationId: number,
	): Promise<GitHubInstallationRepository[]>;
	/** Deletes this tenant's vaulted GitHub token, then the tenant binding. Fails closed. */
	removeInstallation(tenantId: string, installationId: number, userId: string): Promise<void>;
}

export const GITHUB_SETUP_STATE_TTL_SECONDS = 10 * 60;
export const GITHUB_SETUP_COOKIE_NAME = "__Host-procella_github_setup";
/**
 * Same-origin route the Descope outbound callback returns the browser to. The
 * page resumes the installation handoff from there.
 */
export const GITHUB_CONNECT_RETURN_PATH = "/settings/github/connected";
const GITHUB_SETUP_STATE_ISSUER = "procella";
const GITHUB_SETUP_STATE_AUDIENCE = "procella:github-app-installation";
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

export type GitHubSetupErrorCode =
	| "invalid_state"
	| "expired_state"
	| "replayed_state"
	| "authorization_failed"
	| "authorization_required"
	| "authorization_unavailable"
	| "unauthorized_account"
	| "installation_conflict"
	| "invalid_installation"
	| "repository_lookup_failed";

export class GitHubSetupError extends Error {
	constructor(readonly code: GitHubSetupErrorCode) {
		super(code);
		this.name = "GitHubSetupError";
	}
}

export type GitHubSetupPhase = "connect" | "install";

export type GitHubSetupStateInput = {
	tenantId: string;
	/** Present only on install-phase state; a connect-phase state names no account yet. */
	accountLogin?: string;
	initiatorUserId: string;
	browserBinding: string;
	/** Separates the outbound-connect transaction from the installation state. */
	phase: GitHubSetupPhase;
};

export type GitHubSetupStateClaims = GitHubSetupStateInput & {
	jti: string;
	expiresAt: Date;
};

export interface GitHubSetupStateService {
	issue(input: GitHubSetupStateInput): Promise<{ state: string; claims: GitHubSetupStateClaims }>;
	verify(state: string): Promise<GitHubSetupStateClaims>;
}

/**
 * Namespace for the per-connection advisory lock. Fixed and documented so the
 * confirmation and disconnect paths always contend on the same key, and so no
 * other lock in the schema can collide with it.
 */
const GITHUB_OUTBOUND_LOCK_NAMESPACE = "procella:github-outbound-connection";

/**
 * Serializes everything that may confirm or drain one tenant/user connection.
 * Transaction-scoped, so it releases on commit or rollback with no unlock path
 * to forget, and cluster-safe because PostgreSQL owns it.
 */
async function lockOutboundConnection(
	database: Database,
	tenantId: string,
	userId: string,
): Promise<void> {
	const key = JSON.stringify([GITHUB_OUTBOUND_LOCK_NAMESPACE, tenantId, userId]);
	await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export function createGitHubSetupNonce(): string {
	return randomBytes(32).toString("base64url");
}

function githubSetupBrowserBinding(browserNonce: string): string {
	return createHash("sha256").update(browserNonce).digest("hex");
}

export function createGitHubSetupStateService(
	signingKey: string,
	options: { now?: () => Date; ttlSeconds?: number } = {},
): GitHubSetupStateService {
	const secret = new TextEncoder().encode(signingKey);
	const now = options.now ?? (() => new Date());
	const ttlSeconds = options.ttlSeconds ?? GITHUB_SETUP_STATE_TTL_SECONDS;

	return {
		async issue(input) {
			const issuedAt = Math.floor(now().getTime() / 1000);
			const expiresAt = issuedAt + ttlSeconds;
			const jti = randomUUID();
			const state = await new SignJWT(input)
				.setProtectedHeader({ alg: "HS256", typ: "JWT" })
				.setIssuer(GITHUB_SETUP_STATE_ISSUER)
				.setAudience(GITHUB_SETUP_STATE_AUDIENCE)
				.setJti(jti)
				.setIssuedAt(issuedAt)
				.setExpirationTime(expiresAt)
				.sign(secret);
			return {
				state,
				claims: { ...input, jti, expiresAt: new Date(expiresAt * 1000) },
			};
		},
		async verify(state) {
			try {
				const { payload } = await jwtVerify(state, secret, {
					algorithms: ["HS256"],
					audience: GITHUB_SETUP_STATE_AUDIENCE,
					issuer: GITHUB_SETUP_STATE_ISSUER,
					currentDate: now(),
				});
				const phase = payload.phase;
				if (
					typeof payload.tenantId !== "string" ||
					payload.tenantId.length === 0 ||
					typeof payload.initiatorUserId !== "string" ||
					payload.initiatorUserId.length === 0 ||
					typeof payload.browserBinding !== "string" ||
					!/^[0-9a-f]{64}$/.test(payload.browserBinding) ||
					(phase !== "connect" && phase !== "install") ||
					typeof payload.jti !== "string" ||
					!payload.exp
				) {
					throw new GitHubSetupError("invalid_state");
				}
				// A connect-phase state selects no account, so it must never carry
				// one. An install-phase state may: it names the account when the
				// admin picked from the connect list, and omits it when GitHub's
				// own installation picker chooses, which is the only route to an
				// organization the App cannot see yet.
				const rawAccountLogin = payload.accountLogin;
				let accountLogin: string | undefined;
				if (rawAccountLogin !== undefined) {
					if (phase !== "install" || typeof rawAccountLogin !== "string" || !rawAccountLogin) {
						throw new GitHubSetupError("invalid_state");
					}
					accountLogin = rawAccountLogin;
				}
				return {
					tenantId: payload.tenantId,
					accountLogin,
					initiatorUserId: payload.initiatorUserId,
					browserBinding: payload.browserBinding,
					phase,
					jti: payload.jti,
					expiresAt: new Date(payload.exp * 1000),
				};
			} catch (error) {
				if (error instanceof GitHubSetupError) throw error;
				if (error instanceof joseErrors.JWTExpired) {
					throw new GitHubSetupError("expired_state");
				}
				throw new GitHubSetupError("invalid_state");
			}
		},
	};
}

export function buildGitHubAppConfig(config: Config): GitHubAppConfig | null {
	if (
		!config.githubAppId ||
		!config.githubAppPrivateKey ||
		!config.githubAppWebhookSecret ||
		!config.ticketSigningKey
	) {
		return null;
	}

	return {
		appId: config.githubAppId,
		privateKey: config.githubAppPrivateKey,
		webhookSecret: config.githubAppWebhookSecret,
		stateSigningKey: config.ticketSigningKey,
		outboundAppId: config.githubOutboundAppId,
	};
}

export async function verifyGitHubWebhookSignature(
	payload: Uint8Array,
	signature: string,
	secret: string,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) {
		return false;
	}

	const expected = signature.slice(7);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, payload as Uint8Array<ArrayBuffer>);
	const computed = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const computedBuf = Buffer.from(computed, "hex");
	const expectedBuf = Buffer.from(expected, "hex");
	if (computedBuf.length !== expectedBuf.length) {
		return false;
	}

	return timingSafeEqual(computedBuf, expectedBuf);
}

export function buildPRCommentBody(update: {
	updateId: string;
	org: string;
	project: string;
	stack: string;
	kind: string;
	status: string;
	resourceChanges?: Record<string, number>;
	permalink?: string;
}): string {
	const title = update.kind === "preview" ? "Pulumi Preview" : "Pulumi Update";
	const statusLabel = update.status === "running" ? "in progress" : update.status;
	const lines = [
		`<!-- procella:update:${update.updateId} -->`,
		`## ${title}`,
		`**Stack:** \`${update.org}/${update.project}/${update.stack}\``,
		`**Status:** ${statusLabel}`,
	];

	if (update.status !== "running") {
		if (update.resourceChanges) {
			const changes = Object.entries(update.resourceChanges)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([operation, count]) => `${operation} ${count}`);
			lines.push(`**Changes:** ${changes.length > 0 ? changes.join(", ") : "none"}`);
		} else {
			lines.push("**Summary:** unavailable");
		}
	}

	if (update.permalink) lines.push("", `[View details](${update.permalink})`);
	return lines.join("\n");
}

export function buildCommitStatusContext(update: {
	org: string;
	project: string;
	stack: string;
}): string {
	const context = `procella/${update.org}/${update.project}/${update.stack}`;
	if (context.length <= 100) return context;
	const suffix = createHash("sha256").update(context).digest("hex").slice(0, 8);
	return `${context.slice(0, 91)}-${suffix}`;
}

export function mapUpdateStatusToCommitState(
	status: string,
): "pending" | "success" | "failure" | "error" {
	if (status === "succeeded") {
		return "success";
	}
	if (status === "failed" || status === "cancelled") {
		return "failure";
	}
	if (status === "running" || status === "requested" || status === "not started") {
		return "pending";
	}
	return "error";
}

class GitHubDeliveryDeadlineError extends Error {}

function githubRequestOptions(options?: GitHubDeliveryRequestOptions): {
	request: { signal: AbortSignal };
	deadlineBounded: boolean;
} {
	const deadlineRemaining =
		options?.deadlineMs === undefined ? undefined : options.deadlineMs - Date.now();
	if (deadlineRemaining !== undefined && deadlineRemaining <= 0) {
		throw new GitHubDeliveryDeadlineError("GitHub delivery deadline exceeded");
	}
	const deadlineBounded =
		deadlineRemaining !== undefined && deadlineRemaining <= GITHUB_REQUEST_TIMEOUT_MS;
	const timeout = deadlineBounded ? deadlineRemaining : GITHUB_REQUEST_TIMEOUT_MS;
	return {
		request: { signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout))) },
		deadlineBounded,
	};
}

function hasAbortCause(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 5; depth += 1) {
		if (
			current instanceof Error &&
			(current.name === "AbortError" || current.name === "TimeoutError")
		) {
			return true;
		}
		if (typeof current !== "object" || current === null || !("cause" in current)) return false;
		current = current.cause;
	}
	return false;
}

function githubErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
	return typeof error.status === "number" ? error.status : undefined;
}

async function withGitHubRequestDeadline<T>(
	options: GitHubDeliveryRequestOptions | undefined,
	request: (requestOptions: { request: { signal: AbortSignal } }) => Promise<T>,
): Promise<T> {
	const { deadlineBounded, ...requestOptions } = githubRequestOptions(options);
	try {
		return await request(requestOptions);
	} catch (error) {
		if (error instanceof GitHubDeliveryDeadlineError) throw error;
		if (deadlineBounded && (requestOptions.request.signal.aborted || hasAbortCause(error))) {
			throw new GitHubDeliveryDeadlineError("GitHub delivery deadline exceeded");
		}
		throw error;
	}
}

/** GitHub client used by background delivery workers. It needs only App signing credentials. */
export class OctokitGitHubDeliveryService implements GitHubDeliveryService {
	protected readonly db: Database;
	protected readonly appClient: Octokit;
	protected readonly installationClientFactory: (installationId: number) => Octokit;

	constructor({
		db,
		config,
		appClient,
		installationClientFactory,
	}: {
		db: Database;
		config: GitHubDeliveryConfig;
		appClient?: Octokit;
		installationClientFactory?: (installationId: number) => Octokit;
	}) {
		this.db = db;
		this.appClient =
			appClient ??
			new Octokit({
				authStrategy: createAppAuth,
				auth: { appId: config.appId, privateKey: config.privateKey },
				request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
			});
		this.installationClientFactory =
			installationClientFactory ??
			((installationId) =>
				new Octokit({
					authStrategy: createAppAuth,
					auth: { appId: config.appId, privateKey: config.privateKey, installationId },
					request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
				}));
	}

	async listInstallations(tenantId: string): Promise<GitHubInstallationInfo[]> {
		const rows = await this.db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.tenantId, tenantId))
			.orderBy(desc(githubInstallations.updatedAt));
		return rows.map(mapInstallationRow);
	}

	async listInstallationRepositories(
		tenantId: string,
		installationId: number,
	): Promise<GitHubInstallationRepository[]> {
		const installation = (await this.listInstallations(tenantId)).find(
			(candidate) => candidate.installationId === installationId,
		);
		if (!installation || installation.tenantId !== tenantId) {
			throw new GitHubSetupError("invalid_installation");
		}

		try {
			const repositories = await this.installationClientFactory(installationId).paginate(
				"GET /installation/repositories",
				{ per_page: 100 },
			);
			return repositories
				.map((repository): GitHubInstallationRepository => {
					const owner = repository.owner;
					if (
						!Number.isSafeInteger(repository.id) ||
						repository.id <= 0 ||
						typeof repository.name !== "string" ||
						typeof repository.full_name !== "string" ||
						!owner ||
						!Number.isSafeInteger(owner.id) ||
						owner.id <= 0 ||
						typeof owner.login !== "string"
					) {
						throw new GitHubSetupError("repository_lookup_failed");
					}
					return {
						id: repository.id,
						name: repository.name,
						fullName: repository.full_name,
						ownerId: owner.id,
						ownerLogin: owner.login,
						private: repository.private,
					};
				})
				.sort((a, b) => a.fullName.localeCompare(b.fullName));
		} catch (error) {
			if (error instanceof GitHubSetupError) throw error;
			throw new GitHubSetupError("repository_lookup_failed");
		}
	}

	async resolveInstallation(
		target: GitHubRepositoryTarget,
		options?: GitHubDeliveryRequestOptions,
	): Promise<GitHubInstallationInfo | null> {
		const installations = await this.listInstallations(target.tenantId);
		try {
			const { data } = await withGitHubRequestDeadline(options, (requestOptions) =>
				this.appClient.request("GET /repos/{owner}/{repo}/installation", {
					owner: target.owner,
					repo: target.repo,
					...requestOptions,
				}),
			);
			if (!Number.isSafeInteger(data.id)) return null;
			return installations.find((installation) => installation.installationId === data.id) ?? null;
		} catch (error) {
			if (githubErrorStatus(error) === 404) return null;
			throw error;
		}
	}

	async createPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<number> {
		const { data } = await withGitHubRequestDeadline(options, (requestOptions) =>
			this.installationClientFactory(installationId).rest.issues.createComment({
				owner,
				repo,
				issue_number: prNumber,
				body,
				...requestOptions,
			}),
		);
		if (!Number.isSafeInteger(data.id)) throw new Error("GitHub returned an invalid comment ID");
		return data.id;
	}

	async findPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		marker: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<number | null> {
		const octokit = this.installationClientFactory(installationId);
		for (let page = 1; ; page += 1) {
			const { data } = await withGitHubRequestDeadline(options, (requestOptions) =>
				octokit.rest.issues.listComments({
					owner,
					repo,
					issue_number: prNumber,
					per_page: 100,
					page,
					...requestOptions,
				}),
			);
			const match = data.find((comment) => comment.body?.includes(marker));
			if (match) return Number.isSafeInteger(match.id) ? match.id : null;
			if (data.length < 100) return null;
		}
	}

	async updatePRComment(
		installationId: number,
		owner: string,
		repo: string,
		commentId: number,
		body: string,
		options?: GitHubDeliveryRequestOptions,
	): Promise<void> {
		await withGitHubRequestDeadline(options, (requestOptions) =>
			this.installationClientFactory(installationId).rest.issues.updateComment({
				owner,
				repo,
				comment_id: commentId,
				body,
				...requestOptions,
			}),
		);
	}

	async setCommitStatus(
		installationId: number,
		owner: string,
		repo: string,
		sha: string,
		state: "pending" | "success" | "failure" | "error",
		description: string,
		context = "procella/preview",
		options?: GitHubDeliveryRequestOptions,
	): Promise<void> {
		await withGitHubRequestDeadline(options, (requestOptions) =>
			this.installationClientFactory(installationId).rest.repos.createCommitStatus({
				owner,
				repo,
				sha,
				state,
				description,
				context,
				...requestOptions,
			}),
		);
	}
}
export class OctokitGitHubService extends OctokitGitHubDeliveryService implements GitHubService {
	private readonly config: GitHubAppConfig;
	private readonly setupStates: GitHubSetupStateService;
	private readonly outbound: GitHubOutboundIdentityService | null;

	constructor({
		db,
		config,
		appClient,
		installationClientFactory,
		setupStates,
		outbound,
	}: {
		db: Database;
		config: GitHubAppConfig;
		appClient?: Octokit;
		installationClientFactory?: (installationId: number) => Octokit;
		setupStates?: GitHubSetupStateService;
		/**
		 * Vaulted GitHub identity verification. Null disables tenant setup while
		 * leaving webhook handling and PR publication working.
		 */
		outbound?: GitHubOutboundIdentityService | null;
	}) {
		super({ db, config, appClient, installationClientFactory });
		this.config = config;
		this.setupStates = setupStates ?? createGitHubSetupStateService(config.stateSigningKey);
		this.outbound = outbound ?? null;
	}

	get connectAvailable(): boolean {
		return this.outbound !== null;
	}

	async resolveConnectedLogin(tenantId: string, userId: string): Promise<string | null> {
		const identity = await this.outbound?.loadIdentity(userId, tenantId);
		return identity?.login ?? null;
	}

	/**
	 * Opens the connect transaction that authorizes the first outbound leg.
	 *
	 * The signed state is one-time (its `jti` row is consumed later), carries
	 * the tenant and the initiating admin, and is bound to the initiating
	 * browser's `__Host-` nonce. It travels inside the Descope redirect URL,
	 * so an attacker who forwards their authorization link to a victim cannot
	 * make the victim's callback continue: the callback consumes this state in
	 * the victim's browser, where the nonce cookie and session do not match.
	 * No account is named yet: which accounts the caller administers is only
	 * knowable after GitHub authorizes and {@link confirmConnect} runs.
	 */
	async beginConnect(
		tenantId: string,
		initiatorUserId: string,
		browserNonce: string,
	): Promise<string> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		const browserBinding = this.browserBinding(browserNonce);
		const { state, claims } = await this.setupStates.issue({
			tenantId,
			initiatorUserId,
			browserBinding,
			phase: "connect",
		});
		await this.db.delete(githubSetupStates).where(lt(githubSetupStates.expiresAt, sql`now()`));
		await this.db.insert(githubSetupStates).values({
			jti: claims.jti,
			tenantId: claims.tenantId,
			expiresAt: claims.expiresAt,
		});
		return state;
	}

	/**
	 * Consumes the connect transaction and durably confirms the vaulted token,
	 * so it becomes usable at all.
	 *
	 * This is the confirmation boundary. Descope vaults a token as soon as
	 * GitHub authorizes, so until this browser-bound callback records the
	 * token's Descope id, no consumer may observe or use it. No account
	 * administration check runs here: nothing is selected yet, and until the
	 * App is installed the vaulted token cannot read organization membership
	 * anyway. {@link listConnectTargets} and {@link connectInstallation} check
	 * administration once there is an account to check.
	 *
	 * The token read and the confirmation write happen under the
	 * per-connection advisory lock, so a disconnect draining the same slot
	 * cannot interleave and leave this confirmation pointing at a token it
	 * deleted.
	 */
	async confirmConnect(
		connectState: string,
		browserNonce: string,
		initiator: { tenantId: string; userId: string },
	): Promise<GitHubUserIdentity> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		const outbound = this.outbound;
		const claims = await this.setupStates.verify(connectState);
		this.verifyBrowserBinding(browserNonce, claims.browserBinding);
		if (
			claims.phase !== "connect" ||
			claims.tenantId !== initiator.tenantId ||
			claims.initiatorUserId !== initiator.userId
		) {
			throw new GitHubSetupError("invalid_state");
		}

		const pending = await this.db.transaction(async (tx): Promise<GitHubPendingConnection> => {
			await lockOutboundConnection(tx as Database, claims.tenantId, claims.initiatorUserId);
			// Read the vaulted token only after the lock: a token observed earlier
			// could already have been drained by a concurrent disconnect.
			let pending: GitHubPendingConnection;
			try {
				pending = await outbound.loadPendingConnection(claims.initiatorUserId, claims.tenantId);
			} catch (error) {
				throw setupErrorFromOutbound(error);
			}
			await this.consumeSetupState(tx as Database, claims);
			await tx
				.insert(githubOutboundConnections)
				.values({
					tenantId: claims.tenantId,
					userId: claims.initiatorUserId,
					tokenId: pending.tokenId,
				})
				.onConflictDoUpdate({
					target: [githubOutboundConnections.tenantId, githubOutboundConnections.userId],
					set: { tokenId: pending.tokenId, updatedAt: sql`now()` },
				});
			return pending;
		});

		return { login: pending.login };
	}

	/**
	 * Accounts the confirmed connection administers, joined against the App
	 * installations it can see, so the caller can offer Connect (already
	 * installed) or Install (fresh install) per account.
	 *
	 * Both listings come from the same confirmed token; an account the caller
	 * does not administer is excluded even when its installation is visible,
	 * because visibility and administration are different GitHub grants. The
	 * installation's tenant binding is read in one query so `connected` and
	 * `claimedByOtherTenant` reflect Procella's own ownership record, not
	 * GitHub's.
	 */
	async listConnectTargets(tenantId: string, userId: string): Promise<GitHubConnectTarget[]> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		const outbound = this.outbound;
		let candidates: GitHubConnectCandidates;
		try {
			candidates = await outbound.listConnectCandidates(userId, tenantId);
		} catch (error) {
			throw setupErrorFromOutbound(error);
		}
		const { administered, installations } = candidates;

		const installationByLogin = new Map(
			installations.map(
				(installation) => [installation.accountLogin.toLowerCase(), installation] as const,
			),
		);
		const installationIds = administered
			.map((account) => installationByLogin.get(account.login.toLowerCase())?.installationId)
			.filter((id): id is number => id !== undefined);
		const rows = installationIds.length
			? await this.db
					.select({
						installationId: githubInstallations.installationId,
						tenantId: githubInstallations.tenantId,
					})
					.from(githubInstallations)
					.where(inArray(githubInstallations.installationId, installationIds))
			: [];
		const tenantByInstallationId = new Map(rows.map((row) => [row.installationId, row.tenantId]));

		return administered.map((account): GitHubConnectTarget => {
			const installation = installationByLogin.get(account.login.toLowerCase());
			const installationId = installation?.installationId ?? null;
			const rowTenantId =
				installationId !== null ? tenantByInstallationId.get(installationId) : undefined;
			return {
				accountLogin: account.login,
				accountType: account.accountType,
				installationId,
				connected: rowTenantId === tenantId,
				claimedByOtherTenant: rowTenantId !== undefined && rowTenantId !== tenantId,
			};
		});
	}

	/**
	 * Binds an installation the confirmed connection already administers and
	 * can see, for the case where the App is already installed on the account.
	 *
	 * Every read of the connection happens under the per-connection advisory
	 * lock, so a concurrent disconnect either drains the credential before
	 * these checks see it, or waits until this binding is committed. Neither
	 * check tolerates invisible membership: the App is already installed, so a
	 * hidden organization is a denial rather than a pre-installation gap. The
	 * unique `installation_id` index is what refuses an installation another
	 * tenant already claimed.
	 */
	async connectInstallation(
		tenantId: string,
		userId: string,
		installationId: number,
	): Promise<GitHubInstallationInfo> {
		const installation = await this.loadInstallation(installationId);

		return this.db.transaction(async (tx) => {
			await lockOutboundConnection(tx as Database, tenantId, userId);
			const [confirmation] = await tx
				.select({ tokenId: githubOutboundConnections.tokenId })
				.from(githubOutboundConnections)
				.where(
					and(
						eq(githubOutboundConnections.tenantId, tenantId),
						eq(githubOutboundConnections.userId, userId),
					),
				)
				.limit(1);
			const confirmedTokenId = confirmation?.tokenId ?? null;
			await this.verifyVaultedAdministration(
				tenantId,
				userId,
				installation.accountLogin,
				confirmedTokenId,
			);
			await this.verifyVaultedInstallationAccess(
				tenantId,
				userId,
				installationId,
				confirmedTokenId,
			);
			return this.saveInstallation(tenantId, installation, tx as Database);
		});
	}

	/**
	 * Issues a browser-bound GitHub App installation URL.
	 *
	 * With `accountLogin`, the admin picked a listed account and administration
	 * is verified up front, tolerating an invisible organization: a user access
	 * token reaches only what the App can also reach, so an organization
	 * without an installation is hidden from it.
	 *
	 * Without `accountLogin`, GitHub's own installation picker chooses the
	 * account. That is the only route to an organization the connect list
	 * cannot enumerate for the same reason, so there is nothing to verify yet;
	 * {@link completeInstallation} derives the installed account and requires
	 * active administration of it, with no invisible-membership allowance,
	 * before binding anything.
	 */
	async issueInstallationUrl(
		tenantId: string,
		userId: string,
		accountLogin: string | undefined,
		browserNonce: string,
	): Promise<string> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		const browserBinding = this.browserBinding(browserNonce);
		const slug = await this.loadAppSlug();
		const next = await this.setupStates.issue({
			tenantId,
			accountLogin,
			initiatorUserId: userId,
			browserBinding,
			phase: "install",
		});

		await this.db.transaction(async (tx) => {
			await lockOutboundConnection(tx as Database, tenantId, userId);
			const [confirmation] = await tx
				.select({ tokenId: githubOutboundConnections.tokenId })
				.from(githubOutboundConnections)
				.where(
					and(
						eq(githubOutboundConnections.tenantId, tenantId),
						eq(githubOutboundConnections.userId, userId),
					),
				)
				.limit(1);
			const confirmedTokenId = confirmation?.tokenId ?? null;
			if (accountLogin === undefined) {
				// No account to check yet, but the connection still has to exist:
				// the callback verifies administration against this same slot.
				await this.requireConfirmedConnection(confirmedTokenId);
			} else {
				await this.verifyVaultedAdministration(tenantId, userId, accountLogin, confirmedTokenId, {
					allowInvisibleMembership: true,
				});
			}
			await tx.delete(githubSetupStates).where(lt(githubSetupStates.expiresAt, sql`now()`));
			await tx.insert(githubSetupStates).values({
				jti: next.claims.jti,
				tenantId: next.claims.tenantId,
				expiresAt: next.claims.expiresAt,
			});
		});

		const url = new URL(`https://github.com/apps/${slug}/installations/new`);
		url.searchParams.set("state", next.state);
		return url.toString();
	}

	/**
	 * Binds the installation to the tenant. Reached for both `setup_action=install`
	 * and `setup_action=update` (GitHub sends the latter when the App is already
	 * installed on the account), so the state, browser binding, App-authenticated
	 * installation data, and vaulted identity are all re-verified here.
	 *
	 * Every read of the connection happens under the per-connection advisory lock,
	 * so a concurrent disconnect either drains the credential before these checks
	 * see it, or waits until this binding is committed and then removes both. A
	 * verification that ran before the lock could be satisfied by a token the
	 * disconnect deletes a moment later, leaving a binding with no confirmation.
	 *
	 * The confirmed token id is read through `tx` — never through a second pool
	 * connection — and handed to the outbound verification calls directly: they
	 * take that id as an argument rather than reading it themselves, because a
	 * second checkout while this transaction holds the pool's only connection
	 * would deadlock the connection it is waiting on.
	 */
	async completeInstallation(
		state: string,
		installationId: number,
		browserNonce: string,
	): Promise<GitHubInstallationInfo> {
		const claims = await this.setupStates.verify(state);
		this.verifyBrowserBinding(browserNonce, claims.browserBinding);
		if (claims.phase !== "install") {
			throw new GitHubSetupError("invalid_state");
		}

		const installation = await this.loadInstallation(installationId);
		// A state that named an account must match the installation GitHub
		// reports. A state issued for GitHub's own picker named none, so the
		// installed account is the answer rather than something to compare
		// against; the administration check below is what authorizes it, and it
		// runs without the pre-install invisible-membership allowance.
		if (
			claims.accountLogin !== undefined &&
			installation.accountLogin.toLowerCase() !== claims.accountLogin.toLowerCase()
		) {
			throw new GitHubSetupError("unauthorized_account");
		}
		const accountLogin = installation.accountLogin;

		return this.db.transaction(async (tx) => {
			await lockOutboundConnection(tx as Database, claims.tenantId, claims.initiatorUserId);
			const [confirmation] = await tx
				.select({ tokenId: githubOutboundConnections.tokenId })
				.from(githubOutboundConnections)
				.where(
					and(
						eq(githubOutboundConnections.tenantId, claims.tenantId),
						eq(githubOutboundConnections.userId, claims.initiatorUserId),
					),
				)
				.limit(1);
			const confirmedTokenId = confirmation?.tokenId ?? null;
			await this.verifyVaultedAdministration(
				claims.tenantId,
				claims.initiatorUserId,
				accountLogin,
				confirmedTokenId,
			);
			await this.verifyVaultedInstallationAccess(
				claims.tenantId,
				claims.initiatorUserId,
				installationId,
				confirmedTokenId,
			);
			await this.consumeSetupState(tx as Database, claims);
			return this.saveInstallation(claims.tenantId, installation, tx as Database);
		});
	}

	async handleWebhookEvent(event: string, payload: unknown): Promise<void> {
		if (event !== "installation" && event !== "installation_repositories") return;

		const body = payload as {
			action?: string;
			installation?: {
				id?: number;
				account?: { login?: string; type?: "Organization" | "User" };
				repository_selection?: "all" | "selected";
			};
		};
		const installation = body.installation;
		if (!Number.isSafeInteger(installation?.id) || (installation?.id ?? 0) <= 0) return;

		const existing = await this.getInstallationById(installation?.id as number);
		if (!existing) return;

		if (event === "installation" && body.action === "deleted") {
			await this.removeInstallationById(existing.installationId);
			return;
		}

		const accountLogin = installation?.account?.login;
		const accountType = installation?.account?.type;
		const repositorySelection = installation?.repository_selection;
		await this.db
			.update(githubInstallations)
			.set({
				...(accountLogin ? { accountLogin } : {}),
				...(accountType === "Organization" || accountType === "User" ? { accountType } : {}),
				...(repositorySelection === "all" || repositorySelection === "selected"
					? { repositorySelection }
					: {}),
				updatedAt: sql`now()`,
			})
			.where(eq(githubInstallations.installationId, existing.installationId));
	}

	/**
	 * Disconnects the tenant under the per-connection advisory lock: read the
	 * confirmation, drain the tenant's vault slot, then remove the confirmation
	 * row and the tenant binding, all in one transaction.
	 *
	 * Holding the lock across the vault calls is what keeps a concurrent
	 * confirmation honest. Either the confirmation wins the lock first and this
	 * drain then removes the token it recorded, or this drain wins and the
	 * confirmation's own token read finds nothing to confirm. No confirmed row can
	 * be left pointing at a token this call deleted.
	 *
	 * The credential goes first, so a management failure aborts the transaction
	 * and leaves local state intact rather than reporting a disconnect that only
	 * removed the binding. The vault calls all carry hard timeouts. A confirmed
	 * connection with no management credentials configured is refused outright:
	 * the token could not be deleted, so reporting success would be a lie.
	 */
	async removeInstallation(
		tenantId: string,
		installationId: number,
		userId: string,
	): Promise<void> {
		const outbound = this.outbound;
		await this.db.transaction(async (tx) => {
			await lockOutboundConnection(tx as Database, tenantId, userId);
			const [confirmation] = await tx
				.select({ tokenId: githubOutboundConnections.tokenId })
				.from(githubOutboundConnections)
				.where(
					and(
						eq(githubOutboundConnections.tenantId, tenantId),
						eq(githubOutboundConnections.userId, userId),
					),
				)
				.limit(1);

			if (outbound) {
				try {
					await outbound.drainTenantTokens(userId, tenantId, confirmation?.tokenId ?? null);
				} catch {
					throw new GitHubSetupError("authorization_failed");
				}
			} else if (confirmation) {
				// Without management credentials the vaulted token cannot be deleted,
				// so a confirmed connection must not report a disconnect that only
				// removed local rows. A tenant with no confirmation has nothing
				// vaulted to lose, so its binding can still be removed.
				throw new GitHubSetupError("authorization_unavailable");
			}

			await tx
				.delete(githubOutboundConnections)
				.where(
					and(
						eq(githubOutboundConnections.tenantId, tenantId),
						eq(githubOutboundConnections.userId, userId),
					),
				);
			await tx
				.delete(githubInstallations)
				.where(
					and(
						eq(githubInstallations.tenantId, tenantId),
						eq(githubInstallations.installationId, installationId),
					),
				);
		});
	}

	private browserBinding(browserNonce: string): string {
		if (!/^[a-zA-Z0-9_-]{43}$/.test(browserNonce)) {
			throw new GitHubSetupError("invalid_state");
		}
		return githubSetupBrowserBinding(browserNonce);
	}

	private verifyBrowserBinding(browserNonce: string, expectedBinding: string): void {
		if (!/^[0-9a-f]{64}$/.test(expectedBinding)) {
			throw new GitHubSetupError("invalid_state");
		}
		const actual = Buffer.from(this.browserBinding(browserNonce), "hex");
		const expected = Buffer.from(expectedBinding, "hex");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			throw new GitHubSetupError("invalid_state");
		}
	}

	private async consumeSetupState(
		database: Database,
		claims: GitHubSetupStateClaims,
	): Promise<void> {
		const [consumed] = await database
			.delete(githubSetupStates)
			.where(
				and(
					eq(githubSetupStates.jti, claims.jti),
					eq(githubSetupStates.tenantId, claims.tenantId),
					gt(githubSetupStates.expiresAt, sql`now()`),
				),
			)
			.returning({ jti: githubSetupStates.jti });
		if (!consumed) throw new GitHubSetupError("replayed_state");
	}

	/**
	 * Fails closed when the tenant's admin has no confirmed vaulted identity.
	 * Used where there is no account to verify yet, so that the only remaining
	 * precondition is still checked before a signed state is handed out.
	 */
	private async requireConfirmedConnection(confirmedTokenId: string | null): Promise<void> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		if (!confirmedTokenId) throw new GitHubSetupError("authorization_required");
	}

	/** Maps outbound verification failures onto the setup error surface. */
	private async verifyVaultedAdministration(
		tenantId: string,
		userId: string,
		accountLogin: string,
		confirmedTokenId: string | null,
		options: { allowInvisibleMembership?: boolean } = {},
	): Promise<void> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		try {
			await this.outbound.verifyAccountAdministration(
				userId,
				tenantId,
				accountLogin,
				confirmedTokenId,
				options,
			);
		} catch (error) {
			throw setupErrorFromOutbound(error);
		}
	}

	private async verifyVaultedInstallationAccess(
		tenantId: string,
		userId: string,
		installationId: number,
		confirmedTokenId: string | null,
	): Promise<void> {
		if (!this.outbound) throw new GitHubSetupError("authorization_unavailable");
		try {
			await this.outbound.verifyInstallationAccess(
				userId,
				tenantId,
				installationId,
				confirmedTokenId,
			);
		} catch (error) {
			throw setupErrorFromOutbound(error);
		}
	}

	private async saveInstallation(
		tenantId: string,
		installation: GitHubInstallationData,
		database: Database = this.db,
	): Promise<GitHubInstallationInfo> {
		const [row] = await database
			.insert(githubInstallations)
			.values({ tenantId, ...installation })
			.onConflictDoUpdate({
				target: githubInstallations.installationId,
				set: {
					accountLogin: installation.accountLogin,
					accountType: installation.accountType,
					repositorySelection: installation.repositorySelection,
					updatedAt: sql`now()`,
				},
				setWhere: eq(githubInstallations.tenantId, tenantId),
			})
			.returning();

		if (!row) throw new GitHubSetupError("installation_conflict");
		return mapInstallationRow(row);
	}

	private async getInstallationById(
		installationId: number,
	): Promise<GitHubInstallationInfo | null> {
		const [row] = await this.db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.installationId, installationId))
			.limit(1);
		return row ? mapInstallationRow(row) : null;
	}

	private async removeInstallationById(installationId: number): Promise<void> {
		await this.db
			.delete(githubInstallations)
			.where(eq(githubInstallations.installationId, installationId));
	}

	private async loadInstallation(installationId: number): Promise<GitHubInstallationData> {
		try {
			const { data } = await this.appClient.request("GET /app/installations/{installation_id}", {
				installation_id: installationId,
			});
			const account = data.account;
			const accountLogin =
				typeof account === "object" && account && "login" in account ? account.login : undefined;
			const accountType = data.target_type;
			const appId = Number(data.app_id);
			const repositorySelection = data.repository_selection;
			if (
				appId !== Number(this.config.appId) ||
				data.id !== installationId ||
				typeof accountLogin !== "string" ||
				(accountType !== "Organization" && accountType !== "User") ||
				(repositorySelection !== "all" && repositorySelection !== "selected")
			) {
				throw new GitHubSetupError("invalid_installation");
			}

			return { installationId, accountLogin, accountType, repositorySelection };
		} catch (error) {
			if (error instanceof GitHubSetupError) throw error;
			throw new GitHubSetupError("invalid_installation");
		}
	}
	private async loadAppSlug(): Promise<string> {
		try {
			const { data } = await this.appClient.request("GET /app");
			if (
				!data ||
				data.id !== Number(this.config.appId) ||
				typeof data.slug !== "string" ||
				!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(data.slug)
			) {
				throw new Error("GitHub App identity did not match configured credentials");
			}
			return data.slug;
		} catch {
			throw new Error("Unable to verify configured GitHub App");
		}
	}
}

export const GITHUB_OUTBOX_CLAIM_SECONDS = 120;
export const GITHUB_OUTBOX_MAX_ATTEMPTS_PER_RUN = 25;
export const GITHUB_OUTBOX_MAX_ATTEMPTS = 8;
export const GITHUB_OUTBOX_MIN_DELIVERY_BUDGET_MS = 35_000;
export const GITHUB_OUTBOX_POLL_INTERVAL_MS = 5_000;

interface GitHubPublicationTarget {
	tenantId: string;
	owner: string;
	repo: string;
	prNumber: number;
	sha: string;
	org: string;
	project: string;
	stack: string;
}

interface GitHubOutboxClaim {
	id: string;
	updateId: string;
	phase: "started" | "terminal";
	revision: number;
	attempts: number;
	target: GitHubPublicationTarget;
	commentId: string | null;
	kind: string;
	status: string;
	summary: Record<string, unknown> | null;
}

interface RawGitHubOutboxClaim extends Omit<GitHubOutboxClaim, "target" | "summary"> {
	target: unknown;
	summary: unknown;
}

class PermanentGitHubPublicationError extends Error {}

export class GitHubOutboxWorker {
	private readonly db: Database;
	private readonly github: GitHubDeliveryService;
	private readonly interval: number;
	private readonly maxPerRun: number;
	private readonly workerId: string;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor({
		db,
		github,
		interval,
		maxPerRun,
		workerId,
		now,
	}: {
		db: Database;
		github: GitHubDeliveryService;
		interval?: number;
		maxPerRun?: number;
		workerId?: string;
		now?: () => number;
	}) {
		this.db = db;
		this.github = github;
		this.interval = interval ?? GITHUB_OUTBOX_POLL_INTERVAL_MS;
		this.maxPerRun = maxPerRun ?? GITHUB_OUTBOX_MAX_ATTEMPTS_PER_RUN;
		this.workerId = workerId ?? randomUUID();
		this.now = now ?? Date.now;
	}

	async start(): Promise<void> {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runCycle().catch((error) =>
				console.error("[github-outbox] cycle failed", projectError(error)),
			);
		}, this.interval);
		await this.runCycle().catch((error) =>
			console.error("[github-outbox] cycle failed", projectError(error)),
		);
	}
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		while (this.running) await Bun.sleep(25);
	}

	/** Drain one bounded batch without starting work that cannot fit before the deadline. */
	async runOnce({ deadlineMs }: { deadlineMs?: number } = {}): Promise<number> {
		return this.runCycle(deadlineMs);
	}

	private async runCycle(deadlineMs?: number): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let delivered = 0;
		try {
			for (let index = 0; index < this.maxPerRun; index += 1) {
				if (
					deadlineMs !== undefined &&
					deadlineMs - this.now() < GITHUB_OUTBOX_MIN_DELIVERY_BUDGET_MS
				) {
					break;
				}
				const rawClaim = await this.claimNext();
				if (!rawClaim) break;
				try {
					const claim = parseOutboxClaim(rawClaim);
					await this.deliver(claim, deadlineMs);
					if (await this.ack(claim)) delivered += 1;
				} catch (error) {
					await this.retry(rawClaim, error);
				}
			}
			return delivered;
		} finally {
			this.running = false;
		}
	}

	private async claimNext(): Promise<RawGitHubOutboxClaim | null> {
		return this.db.transaction(async (tx) => {
			const result = await tx.execute(sql`
				WITH candidate AS (
					SELECT outbox.id
					FROM github_update_outbox outbox
					WHERE GREATEST(outbox.delivered_revision, outbox.failed_revision) < outbox.revision
						AND outbox.available_at <= now()
						AND (outbox.claimed_until IS NULL OR outbox.claimed_until < now())
						AND (
							outbox.phase = 'started'
							OR NOT EXISTS (
								SELECT 1 FROM github_update_outbox started
								WHERE started.update_id = outbox.update_id
									AND started.phase = 'started'
									AND GREATEST(started.delivered_revision, started.failed_revision) < started.revision
							)
						)
					ORDER BY outbox.created_at, CASE outbox.phase WHEN 'started' THEN 0 ELSE 1 END
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				), claimed AS (
					UPDATE github_update_outbox outbox
					SET claimed_by = ${this.workerId}::uuid,
						claimed_until = now() + (${GITHUB_OUTBOX_CLAIM_SECONDS} * interval '1 second'),
						attempts = outbox.attempts + 1,
						updated_at = now()
					FROM candidate
					WHERE outbox.id = candidate.id
					RETURNING outbox.*
				)
				SELECT claimed.id, claimed.update_id AS "updateId", claimed.phase,
					claimed.revision, claimed.attempts, source_update.github_target AS target,
					source_update.github_comment_id AS "commentId", source_update.kind,
					source_update.status, source_update.summary
				FROM claimed
				JOIN updates source_update ON source_update.id = claimed.update_id
			`);
			const row = readExecuteRows<RawGitHubOutboxClaim>(result)[0];
			return row ?? null;
		});
	}

	private async deliver(claim: GitHubOutboxClaim, deadlineMs?: number): Promise<void> {
		const { target } = claim;
		const options = { deadlineMs };
		this.assertWithinDeadline(deadlineMs);
		const installation = await this.github.resolveInstallation(target, options);
		if (!installation) throw new Error("No authorized GitHub App installation for repository");
		await this.renewClaim(claim);

		const marker = `<!-- procella:update:${claim.updateId} -->`;
		const body = buildPRCommentBody({
			updateId: claim.updateId,
			org: target.org,
			project: target.project,
			stack: target.stack,
			kind: claim.kind,
			status: claim.phase === "started" ? "running" : claim.status,
			resourceChanges:
				claim.phase === "terminal" ? resourceChangesFromSummary(claim.summary) : undefined,
		});

		let commentId = parseGitHubCommentId(claim.commentId);
		if (commentId === null) {
			this.assertWithinDeadline(deadlineMs);
			commentId = await this.github.findPRComment(
				installation.installationId,
				target.owner,
				target.repo,
				target.prNumber,
				marker,
				options,
			);
		}
		await this.renewClaim(claim);
		this.assertWithinDeadline(deadlineMs);
		if (commentId === null) {
			commentId = await this.github.createPRComment(
				installation.installationId,
				target.owner,
				target.repo,
				target.prNumber,
				body,
				options,
			);
		} else {
			await this.github.updatePRComment(
				installation.installationId,
				target.owner,
				target.repo,
				commentId,
				body,
				options,
			);
		}
		if (claim.commentId === null) await this.persistCommentId(claim, commentId);

		this.assertWithinDeadline(deadlineMs);
		const status = claim.phase === "started" ? "running" : claim.status;
		await this.github.setCommitStatus(
			installation.installationId,
			target.owner,
			target.repo,
			target.sha,
			mapUpdateStatusToCommitState(status),
			`Procella ${claim.kind} ${status === "running" ? "in progress" : status}`,
			buildCommitStatusContext(target),
			options,
		);
	}

	private assertWithinDeadline(deadlineMs?: number): void {
		if (deadlineMs !== undefined && this.now() >= deadlineMs) {
			throw new GitHubDeliveryDeadlineError("GitHub delivery deadline exceeded");
		}
	}

	private async renewClaim(claim: GitHubOutboxClaim): Promise<void> {
		const rows = await this.db
			.update(githubUpdateOutbox)
			.set({
				claimedUntil: sql`now() + (${GITHUB_OUTBOX_CLAIM_SECONDS} * interval '1 second')`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(githubUpdateOutbox.id, claim.id),
					eq(githubUpdateOutbox.claimedBy, this.workerId),
					eq(githubUpdateOutbox.revision, claim.revision),
				),
			)
			.returning({ id: githubUpdateOutbox.id });
		if (rows.length === 0) throw new Error("GitHub outbox claim lease lost");
	}

	private async persistCommentId(claim: GitHubOutboxClaim, commentId: number): Promise<void> {
		const rows = await this.db.transaction(async (tx) => {
			const owned = await tx
				.update(githubUpdateOutbox)
				.set({
					claimedUntil: sql`now() + (${GITHUB_OUTBOX_CLAIM_SECONDS} * interval '1 second')`,
					updatedAt: sql`now()`,
				})
				.where(
					and(
						eq(githubUpdateOutbox.id, claim.id),
						eq(githubUpdateOutbox.claimedBy, this.workerId),
						eq(githubUpdateOutbox.revision, claim.revision),
					),
				)
				.returning({ id: githubUpdateOutbox.id });
			if (owned.length === 0) return [];
			return tx
				.update(updates)
				.set({ githubCommentId: String(commentId), updatedAt: sql`now()` })
				.where(and(eq(updates.id, claim.updateId), sql`${updates.githubCommentId} IS NULL`))
				.returning({ id: updates.id });
		});
		if (rows.length === 0) throw new Error("GitHub outbox claim lease lost");
	}

	private async ack(claim: GitHubOutboxClaim): Promise<boolean> {
		const rows = await this.db
			.update(githubUpdateOutbox)
			.set({
				deliveredRevision: claim.revision,
				attempts: 0,
				claimedBy: null,
				claimedUntil: null,
				failedAt: null,
				lastError: null,
				availableAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(githubUpdateOutbox.id, claim.id),
					eq(githubUpdateOutbox.claimedBy, this.workerId),
					eq(githubUpdateOutbox.revision, claim.revision),
				),
			)
			.returning({ id: githubUpdateOutbox.id });
		if (rows.length > 0) return true;
		await this.releaseSupersededClaim(claim);
		return false;
	}

	private async retry(claim: RawGitHubOutboxClaim, error: unknown): Promise<void> {
		if (error instanceof GitHubDeliveryDeadlineError) {
			const rows = await this.db
				.update(githubUpdateOutbox)
				.set({
					claimedBy: null,
					claimedUntil: null,
					attempts: sql`GREATEST(${githubUpdateOutbox.attempts} - 1, 0)`,
					availableAt: sql`now()`,
					lastError: sanitizeDeliveryError(error),
					updatedAt: sql`now()`,
				})
				.where(
					and(
						eq(githubUpdateOutbox.id, claim.id),
						eq(githubUpdateOutbox.claimedBy, this.workerId),
						eq(githubUpdateOutbox.revision, claim.revision),
					),
				)
				.returning({ id: githubUpdateOutbox.id });
			if (rows.length === 0) await this.releaseSupersededClaim(claim);
			return;
		}
		const terminal =
			error instanceof PermanentGitHubPublicationError ||
			claim.attempts >= GITHUB_OUTBOX_MAX_ATTEMPTS;
		const delaySeconds = githubRetryDelaySeconds(claim.attempts);
		const rows = await this.db
			.update(githubUpdateOutbox)
			.set({
				claimedBy: null,
				claimedUntil: null,
				...(terminal
					? { failedRevision: claim.revision, failedAt: sql`now()` }
					: { availableAt: sql`now() + (${delaySeconds} * interval '1 second')` }),
				lastError: sanitizeDeliveryError(error),
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(githubUpdateOutbox.id, claim.id),
					eq(githubUpdateOutbox.claimedBy, this.workerId),
					eq(githubUpdateOutbox.revision, claim.revision),
				),
			)
			.returning({ id: githubUpdateOutbox.id });
		if (rows.length === 0) await this.releaseSupersededClaim(claim);
	}

	private async releaseSupersededClaim(
		claim: Pick<RawGitHubOutboxClaim, "id" | "revision">,
	): Promise<void> {
		await this.db
			.update(githubUpdateOutbox)
			.set({
				claimedBy: null,
				claimedUntil: null,
				availableAt: sql`now()`,
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(githubUpdateOutbox.id, claim.id),
					eq(githubUpdateOutbox.claimedBy, this.workerId),
					gt(githubUpdateOutbox.revision, claim.revision),
				),
			);
	}
}

function parseOutboxClaim(raw: RawGitHubOutboxClaim): GitHubOutboxClaim {
	return {
		...raw,
		target: parseGitHubPublicationTarget(raw.target),
		summary: raw.summary === null ? null : parseJsonRecord(raw.summary, "update summary"),
	};
}

function parseJsonRecord(value: unknown, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		throw new PermanentGitHubPublicationError(`Invalid ${label} in PostgreSQL`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PermanentGitHubPublicationError(`Invalid ${label} in PostgreSQL`);
	}
	return parsed as Record<string, unknown>;
}

function parseGitHubPublicationTarget(value: unknown): GitHubPublicationTarget {
	const target = parseJsonRecord(value, "GitHub publication target");
	if (
		typeof target.tenantId !== "string" ||
		typeof target.owner !== "string" ||
		typeof target.repo !== "string" ||
		typeof target.prNumber !== "number" ||
		!Number.isSafeInteger(target.prNumber) ||
		typeof target.sha !== "string" ||
		typeof target.org !== "string" ||
		typeof target.project !== "string" ||
		typeof target.stack !== "string"
	) {
		throw new PermanentGitHubPublicationError("Invalid GitHub publication target in PostgreSQL");
	}
	return target as unknown as GitHubPublicationTarget;
}

function resourceChangesFromSummary(
	summary: Record<string, unknown> | null,
): Record<string, number> | undefined {
	const changes = summary?.resourceChanges;
	if (!changes || typeof changes !== "object" || Array.isArray(changes)) return undefined;
	return Object.fromEntries(
		Object.entries(changes).filter(
			(entry): entry is [string, number] =>
				typeof entry[1] === "number" && Number.isFinite(entry[1]),
		),
	);
}

function parseGitHubCommentId(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function githubRetryDelaySeconds(attempts: number): number {
	return Math.min(900, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

export function sanitizeDeliveryError(error: unknown): string {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return message
		.replace(/authorization["']?\s*[:=]\s*[^\r\n,}]+/gi, "authorization=[redacted]")
		.replace(/(token|secret|private[-_ ]?key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
		.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
		.slice(0, 500);
}

function readExecuteRows<T>(result: unknown): T[] {
	if (Array.isArray(result)) return result as T[];
	if (typeof result === "object" && result !== null && "rows" in result) {
		const rows = result.rows;
		if (Array.isArray(rows)) return rows as T[];
	}
	throw new Error("Unexpected database execute result shape");
}

function mapInstallationRow(row: typeof githubInstallations.$inferSelect): GitHubInstallationInfo {
	return {
		id: row.id,
		tenantId: row.tenantId,
		installationId: row.installationId,
		accountLogin: row.accountLogin,
		accountType: row.accountType as "Organization" | "User",
		repositorySelection: row.repositorySelection as "all" | "selected",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
