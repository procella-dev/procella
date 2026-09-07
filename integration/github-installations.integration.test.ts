import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import type { Database } from "@procella/db";
import { githubInstallations, githubOutboundConnections } from "@procella/db";
import { eq, sql } from "drizzle-orm";
import {
	GitHubOutboundError,
	type GitHubOutboundIdentityService,
	OctokitGitHubService,
	PostgresGitHubOutboundConfirmations,
	VaultedGitHubIdentityService,
} from "@procella/github";
import { getTestDb, truncateTables } from "./setup.js";

const config = {
	appId: "123",
	privateKey: "unused-in-tests",
	webhookSecret: "webhook-secret",
	stateSigningKey: "state-signing-key-state-signing-key",
	outboundAppId: "procella-github",
};

const BROWSER_NONCE = "a".repeat(43);

const installations = new Map([
	[
		101,
		{
			id: 101,
			app_id: 123,
			account: { login: "acme" },
			target_type: "Organization",
			repository_selection: "all",
		},
	],
	[
		102,
		{
			id: 102,
			app_id: 123,
			account: { login: "octocat" },
			target_type: "User",
			repository_selection: "selected",
		},
	],
	[
		201,
		{
			id: 201,
			app_id: 123,
			account: { login: "globex" },
			target_type: "Organization",
			repository_selection: "all",
		},
	],
] as const);

let db: Database;

beforeAll(() => {
	db = getTestDb();
});

afterEach(async () => {
	vaultTokens.clear();
	await truncateTables();
});

/** Tenant slots Descope is pretending to hold, so deletes actually empty them. */
const vaultTokens = new Set<string>();

/** Slot key and token id are derived the same way wherever the stub needs them. */
function vaultSlot(tenantId: string, userId: string): string {
	return `${tenantId}|${userId}`;
}

function vaultTokenId(tenantId: string, userId: string): string {
	return `tok-${tenantId}-${userId}`;
}

function createService(overrides: { outbound?: GitHubOutboundIdentityService } = {}) {
	const appClient = {
		request: async (route: string, input?: { installation_id: number }) => {
			if (route === "GET /app") return { data: { id: 123, slug: "procella-test" } };
			const installationId = input?.installation_id;
			const data = installations.get(installationId as 101 | 102 | 201);
			if (!data) throw Object.assign(new Error("Not Found"), { status: 404 });
			return { data };
		},
	} as unknown as Octokit;
	const outbound: GitHubOutboundIdentityService = overrides.outbound ?? vaultBackedOutbound();
	return new OctokitGitHubService({ db, config, appClient, outbound });
}

/**
 * Vault stub keyed by (user, tenant): each tenant admin holds its own token
 * whose GitHub user is an active organization administrator. Confirmations are
 * read from the real table, so these tests exercise the durable boundary and
 * database-level tenant isolation rather than GitHub's verification.
 */
function vaultBackedOutbound(): GitHubOutboundIdentityService {
	return new VaultedGitHubIdentityService(
		{
			// Deleting a token empties that tenant's slot, so disconnect's drain
			// loop terminates the way it does against Descope.
			fetchUserToken: async (userId, tenantId) =>
				vaultTokens.has(vaultSlot(tenantId, userId))
					? {
							outcome: "found",
							token: {
								id: vaultTokenId(tenantId, userId),
								accessToken: `user-token-${tenantId}`,
							},
						}
					: { outcome: "absent" },
			deleteToken: async (tokenId) => {
				for (const slot of vaultTokens) {
					const [slotTenantId, slotUserId] = slot.split("|");
					if (slotTenantId && slotUserId && vaultTokenId(slotTenantId, slotUserId) === tokenId) {
						vaultTokens.delete(slot);
					}
				}
			},
		},
		new PostgresGitHubOutboundConfirmations(db),
		(token) =>
			({
				request: async (route: string) => {
					if (route === "GET /user/installations") {
						const visible = [...installations.values()];
						return { data: { total_count: visible.length, installations: visible } };
					}
					if (route === "GET /user") return { data: { login: `${token}-github` } };
					return { data: { state: "active", role: "admin" } };
				},
			}) as unknown as Octokit,
	);
}

async function issueInstallState(
	service: OctokitGitHubService,
	tenantId: string,
	installationId: number,
): Promise<string> {
	const installation = installations.get(installationId as 101 | 102 | 201);
	if (!installation) throw new Error("Unknown test installation");
	vaultTokens.add(vaultSlot(tenantId, `${tenantId}-admin`));
	const connectState = await service.beginConnect(
		tenantId,
		installation.account.login,
		`${tenantId}-admin`,
		BROWSER_NONCE,
	);
	const installationUrl = new URL(
		await service.issueInstallationUrl(connectState, BROWSER_NONCE, {
			tenantId,
			userId: `${tenantId}-admin`,
		}),
	);
	const installationState = installationUrl.searchParams.get("state");
	if (!installationState) throw new Error("Installation URL did not include state");
	return installationState;
}

async function bind(service: OctokitGitHubService, tenantId: string, installationId: number) {
	return service.completeInstallation(
		await issueInstallState(service, tenantId, installationId),
		installationId,
		BROWSER_NONCE,
	);
}

async function confirmedRows(tenantId: string): Promise<string[]> {
	const rows = await db
		.select({ tokenId: githubOutboundConnections.tokenId })
		.from(githubOutboundConnections)
		.where(eq(githubOutboundConnections.tenantId, tenantId));
	return rows.map((row) => row.tokenId);
}

/** Runs the browser-bound callback so the tenant's vaulted token is confirmed. */
async function confirm(
	service: OctokitGitHubService,
	tenantId: string,
	userId: string,
	installationId: number,
): Promise<void> {
	const installation = installations.get(installationId as 101 | 102 | 201);
	if (!installation) throw new Error("Unknown test installation");
	vaultTokens.add(vaultSlot(tenantId, userId));
	const connectState = await service.beginConnect(
		tenantId,
		installation.account.login,
		userId,
		BROWSER_NONCE,
	);
	await service.issueInstallationUrl(connectState, BROWSER_NONCE, { tenantId, userId });
}

describe("GitHub installation binding integration", () => {
	test("isolates authorized installations across tenants", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await bind(service, "tenant-b", 201);

		expect((await service.listInstallations("tenant-a")).map((row) => row.installationId)).toEqual([
			101,
		]);
		expect((await service.listInstallations("tenant-b")).map((row) => row.installationId)).toEqual([
			201,
		]);
	});

	test("rejects cross-tenant state use for an already-bound installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);

		await expect(bind(service, "tenant-b", 101)).rejects.toMatchObject({
			code: "installation_conflict",
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
		expect(await service.listInstallations("tenant-b")).toHaveLength(0);
	});

	test("consumes setup state exactly once under concurrent callbacks", async () => {
		const service = createService();
		const state = await issueInstallState(service, "tenant-a", 101);
		const results = await Promise.allSettled([
			service.completeInstallation(state, 101, BROWSER_NONCE),
			service.completeInstallation(state, 101, BROWSER_NONCE),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: { code: "replayed_state" },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("rejects a pre-existing installation callback from a foreign browser", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		const state = await issueInstallState(service, "tenant-a", 101);

		await expect(service.completeInstallation(state, 101, "b".repeat(43))).rejects.toMatchObject({
			code: "invalid_state",
		});
		// setup_action=update re-binds the same installation for the same tenant.
		await expect(service.completeInstallation(state, 101, BROWSER_NONCE)).resolves.toMatchObject({
			tenantId: "tenant-a",
			installationId: 101,
		});
	});

	test("tenant-scoped removal cannot delete another tenant installation", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		await service.removeInstallation("tenant-b", 101, "tenant-b-admin");
		expect(await service.listInstallations("tenant-a")).toHaveLength(1);
	});

	test("keeps one Descope user's confirmed tenant connections independent", async () => {
		const tokens = new Map([
			[vaultSlot("tenant-a", "user-shared"), { id: "tok-a", accessToken: "user-token-tenant-a" }],
			[vaultSlot("tenant-b", "user-shared"), { id: "tok-b", accessToken: "user-token-tenant-b" }],
		]);
		const deleted: string[] = [];
		const service = createService({
			outbound: new VaultedGitHubIdentityService(
				{
					fetchUserToken: async (userId, tenantId) => {
						const token = tokens.get(vaultSlot(tenantId, userId));
						return token ? { outcome: "found", token } : { outcome: "absent" };
					},
					deleteToken: async (tokenId) => {
						deleted.push(tokenId);
						for (const [key, token] of tokens) {
							if (token.id === tokenId) tokens.delete(key);
						}
					},
				},
				new PostgresGitHubOutboundConfirmations(db),
				(token) =>
					({
						request: async (route: string) => {
							if (route === "GET /user/installations") {
								const visible = [...installations.values()];
								return { data: { total_count: visible.length, installations: visible } };
							}
							if (route === "GET /user") return { data: { login: `${token}-github` } };
							return { data: { state: "active", role: "admin" } };
						},
					}) as unknown as Octokit,
			),
		});

		// A vaulted token is invisible until its browser-bound callback confirms it.
		expect(await service.resolveConnectedLogin("tenant-a", "user-shared")).toBeNull();
		await confirm(service, "tenant-a", "user-shared", 101);
		await confirm(service, "tenant-b", "user-shared", 201);

		expect(await service.resolveConnectedLogin("tenant-a", "user-shared")).toBe(
			"user-token-tenant-a-github",
		);
		expect(await service.resolveConnectedLogin("tenant-b", "user-shared")).toBe(
			"user-token-tenant-b-github",
		);

		await service.removeInstallation("tenant-a", 101, "user-shared");

		// Only tenant A's confirmed token is deleted; tenant B keeps its connection.
		expect(deleted).toEqual(["tok-a"]);
		expect(await service.resolveConnectedLogin("tenant-a", "user-shared")).toBeNull();
		expect(await service.resolveConnectedLogin("tenant-b", "user-shared")).toBe(
			"user-token-tenant-b-github",
		);
	});

	test("a forwarded connect URL leaves the vaulted token unconfirmed and unusable", async () => {
		const service = createService();

		// Descope has vaulted a token for the initiator, but the callback never ran
		// in the initiating browser.
		vaultTokens.add(vaultSlot("tenant-a", "tenant-a-admin"));
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBeNull();

		const connectState = await service.beginConnect(
			"tenant-a",
			"acme",
			"tenant-a-admin",
			BROWSER_NONCE,
		);
		await expect(
			service.issueInstallationUrl(connectState, "c".repeat(43), {
				tenantId: "tenant-a",
				userId: "tenant-a-admin",
			}),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBeNull();

		// The initiating browser confirms it, and only then is it usable.
		await service.issueInstallationUrl(connectState, BROWSER_NONCE, {
			tenantId: "tenant-a",
			userId: "tenant-a-admin",
		});
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBe(
			"user-token-tenant-a-github",
		);
	});

	test("serializes a reconnect against a disconnect draining the same slot", async () => {
		// Both paths contend on the same per-connection advisory lock, so whichever
		// wins runs to completion first. Order 1: the disconnect wins.
		const vault = new Map<string, string>([["tenant-a|tenant-a-admin", "tok-a"]]);
		const service = createService({
			outbound: {
				loadIdentity: async (userId, tenantId) =>
					vault.has(vaultSlot(tenantId, userId)) ? { login: "alice" } : null,
				loadPendingConnection: async (userId, tenantId) => {
					const tokenId = vault.get(vaultSlot(tenantId, userId));
					// The drain emptied the slot first, so there is nothing to confirm.
					if (!tokenId) throw new GitHubOutboundError("authorization_required");
					return { tokenId, login: "alice" };
				},
				verifyAccountAdministration: async () => undefined,
				verifyInstallationAccess: async () => undefined,
				drainTenantTokens: async (userId, tenantId) => {
					const slot = vaultSlot(tenantId, userId);
					const drained = vault.get(slot);
					vault.delete(slot);
					return drained ? [drained] : [];
				},
			},
		});
		await bind(service, "tenant-a", 101);

		await service.removeInstallation("tenant-a", 101, "tenant-a-admin");

		// Vault and local state are both empty, and a reconnect arriving after the
		// disconnect cannot confirm the drained token.
		expect(await confirmedRows("tenant-a")).toEqual([]);
		expect(await service.listInstallations("tenant-a")).toHaveLength(0);
		const connectState = await service.beginConnect(
			"tenant-a",
			"acme",
			"tenant-a-admin",
			BROWSER_NONCE,
		);
		await expect(
			service.issueInstallationUrl(connectState, BROWSER_NONCE, {
				tenantId: "tenant-a",
				userId: "tenant-a-admin",
			}),
		).rejects.toMatchObject({ code: "authorization_required" });
		expect(await confirmedRows("tenant-a")).toEqual([]);
	});

	test("a reconnect that wins the lock is drained by the disconnect that follows", async () => {
		// Order 2: the reconnect wins, confirming token B, and the disconnect that
		// follows reads B under the lock and drains exactly that generation.
		const vault = new Map<string, string>([["tenant-a|tenant-a-admin", "tok-b"]]);
		const drained: Array<string | null> = [];
		const service = createService({
			outbound: {
				loadIdentity: async (userId, tenantId) =>
					vault.has(vaultSlot(tenantId, userId)) ? { login: "alice" } : null,
				loadPendingConnection: async (userId, tenantId) => {
					const tokenId = vault.get(vaultSlot(tenantId, userId));
					if (!tokenId) throw new GitHubOutboundError("authorization_required");
					return { tokenId, login: "alice" };
				},
				verifyAccountAdministration: async () => undefined,
				verifyInstallationAccess: async () => undefined,
				drainTenantTokens: async (userId, tenantId, expectedTokenId) => {
					drained.push(expectedTokenId);
					const slot = vaultSlot(tenantId, userId);
					const current = vault.get(slot);
					vault.delete(slot);
					return current ? [current] : [];
				},
			},
		});
		await bind(service, "tenant-a", 101);
		expect(await confirmedRows("tenant-a")).toEqual(["tok-b"]);

		await service.removeInstallation("tenant-a", 101, "tenant-a-admin");

		// The confirmation the reconnect wrote is exactly what got drained, so no
		// confirmed row is ever left pointing at a deleted token.
		expect(drained).toEqual(["tok-b"]);
		expect(await confirmedRows("tenant-a")).toEqual([]);
		expect(await service.listInstallations("tenant-a")).toHaveLength(0);
		expect(await service.resolveConnectedLogin("tenant-a", "tenant-a-admin")).toBeNull();
	});

	test("disconnecting one tenant leaves another tenant's confirmation intact", async () => {
		const service = createService();
		await confirm(service, "tenant-a", "user-shared", 101);
		await confirm(service, "tenant-b", "user-shared", 201);

		await service.removeInstallation("tenant-a", 101, "user-shared");

		expect(await confirmedRows("tenant-a")).toEqual([]);
		expect(await confirmedRows("tenant-b")).toEqual(["tok-tenant-b-user-shared"]);
	});

	test("refuses to disconnect a confirmed tenant without management credentials", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		const tokenId = vaultTokenId("tenant-a", "tenant-a-admin");
		expect(await confirmedRows("tenant-a")).toEqual([tokenId]);

		// Same database, but built the way bootstrap builds it when the Descope
		// management key is missing: the vaulted token cannot be deleted.
		const unmanaged = new OctokitGitHubService({ db, config, appClient: {} as Octokit });
		await expect(
			unmanaged.removeInstallation("tenant-a", 101, "tenant-a-admin"),
		).rejects.toMatchObject({ code: "authorization_unavailable" });

		// The token is still live in the vault, so the row that names it and the
		// binding it belongs to both survive and a later call can still revoke it.
		expect(await confirmedRows("tenant-a")).toEqual([tokenId]);
		expect((await service.listInstallations("tenant-a")).map((row) => row.installationId)).toEqual(
			[101],
		);
		expect(vaultTokens.has(vaultSlot("tenant-a", "tenant-a-admin"))).toBe(true);
	});

	test("removes an unconfirmed binding without management credentials", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);
		// A binding predating the outbound app: no confirmation names a token, so
		// there is no credential this removal could strand.
		await db
			.delete(githubOutboundConnections)
			.where(eq(githubOutboundConnections.tenantId, "tenant-a"));

		const unmanaged = new OctokitGitHubService({ db, config, appClient: {} as Octokit });
		await unmanaged.removeInstallation("tenant-a", 101, "tenant-a-admin");
		expect(await service.listInstallations("tenant-a")).toHaveLength(0);
	});

	test("webhooks update and delete only existing installation bindings", async () => {
		const service = createService();
		await bind(service, "tenant-a", 101);

		await service.handleWebhookEvent("installation_repositories", {
			action: "removed",
			installation: {
				id: 101,
				account: { login: "acme-renamed", type: "Organization" },
				repository_selection: "selected",
			},
		});
		expect(await service.listInstallations("tenant-a")).toMatchObject([
			{ accountLogin: "acme-renamed", repositorySelection: "selected" },
		]);

		await service.handleWebhookEvent("installation", {
			action: "deleted",
			installation: { id: 101 },
		});
		expect(await service.listInstallations("tenant-a")).toHaveLength(0);
	});
});

// ============================================================================
// Lock-ordered concurrency: confirmation versus disconnect
// ============================================================================
//
// Both operations run at once against real PostgreSQL, so the per-connection
// advisory lock is the only thing that can serialize them. A slow Descope round
// trip is simulated with a gate the test releases; the assertions are on
// observable ordering, blocking, and final state rather than on which SQL ran.

/** A promise the test releases, standing in for a slow Descope round trip. */
function gate(): { opened: Promise<void>; release: () => void } {
	let release = (): void => undefined;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { opened, release: () => release() };
}

/**
 * Waits for one of this test's own in-process counters to reach a value an
 * async callback sets from inside a locked transaction. Nothing in this
 * process emits an event when that happens, so polling the counter is the
 * only way to observe it; the loop returns the instant it is true and never
 * lengthens a passing run.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(10);
	}
	return condition();
}

/**
 * Waits until PostgreSQL itself reports a session other than this one blocked
 * on the outbound connection's advisory lock. `hashtextextended` appears only
 * in `lockOutboundConnection`'s statement in this codebase, so matching a
 * blocked backend's query text is proof that the contending transaction
 * reached the database and is waiting on this exact lock — not a guess from
 * elapsed time, which a slow-starting contender or a differing lock key would
 * both pass unnoticed.
 */
async function waitForLockWaiter(timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await db.execute(sql`
			SELECT count(*)::int AS waiters
			FROM pg_stat_activity
			WHERE wait_event_type = 'Lock'
				AND query ILIKE '%hashtextextended%'
				AND pid <> pg_backend_pid()
		`);
		const rows = "rows" in result ? result.rows : (result as unknown[]);
		const waiters = Number((rows[0] as { waiters?: number } | undefined)?.waiters ?? 0);
		if (waiters > 0) return;
		// Polling, not a fixed wait: the condition is PostgreSQL's own server-side
		// lock-wait state on a separate connection, which no fake timer can drive
		// and which Postgres has no push notification for. The loop exits the
		// instant `waiters` is observed, so it never lengthens a passing run.
		await Bun.sleep(10);
	}
	throw new Error(
		"timed out waiting for a contending transaction to block on the outbound connection lock",
	);
}

const RECONNECT_INITIATOR = { tenantId: "tenant-a", userId: "tenant-a-admin" } as const;

interface LockHarness {
	/** Ordered trace of what the vault saw, from inside the locked callbacks. */
	readonly events: string[];
	readonly service: OctokitGitHubService;
	/** Descope's tenant slot: one token id at a time, as the real vault behaves. */
	readonly vault: Map<string, string>;
	pendingReads: number;
	drains: number;
}

/**
 * A service whose vault calls report their own interleaving and can be paused
 * mid-flight, so a test can hold one locked transaction open while the other
 * operation tries to run.
 */
function lockHarness(options: {
	initialTokenId?: string;
	/** Runs inside the confirmation's lock, before the vault is read. */
	onPendingRead?: () => Promise<void>;
	/** Runs inside the disconnect's lock, before the slot is emptied. */
	onDrain?: () => Promise<void>;
	/** Runs inside the disconnect's lock, after the slot is emptied. */
	afterDrain?: (vault: Map<string, string>, slot: string) => void;
}): LockHarness {
	const slot = vaultSlot("tenant-a", "tenant-a-admin");
	const vault = new Map<string, string>(
		options.initialTokenId ? [[slot, options.initialTokenId]] : [],
	);
	const events: string[] = [];
	const harness = { events, vault, pendingReads: 0, drains: 0 } as LockHarness;

	harness.service = createService({
		outbound: {
			loadIdentity: async (userId, tenantId) =>
				vault.has(vaultSlot(tenantId, userId)) ? { login: "alice" } : null,
			loadPendingConnection: async (userId, tenantId) => {
				harness.pendingReads += 1;
				events.push("pending:enter");
				await options.onPendingRead?.();
				const tokenId = vault.get(vaultSlot(tenantId, userId));
				if (!tokenId) {
					events.push("pending:absent");
					throw new GitHubOutboundError("authorization_required");
				}
				events.push(`pending:${tokenId}`);
				return { tokenId, login: "alice" };
			},
			verifyAccountAdministration: async () => undefined,
			verifyInstallationAccess: async () => undefined,
			drainTenantTokens: async (userId, tenantId, expectedTokenId) => {
				harness.drains += 1;
				events.push(`drain:enter:${expectedTokenId ?? "none"}`);
				await options.onDrain?.();
				const key = vaultSlot(tenantId, userId);
				const drained = vault.get(key);
				vault.delete(key);
				events.push(`drain:done:${drained ?? "none"}`);
				options.afterDrain?.(vault, key);
				return drained ? [drained] : [];
			},
		},
	});
	return harness;
}

/**
 * Opens a connect transaction and hands back a starter, so the caller decides
 * when the locked callback runs. A helper that returned the call itself would
 * be awaited by its caller and could never interleave.
 */
async function reconnectStarter(service: OctokitGitHubService): Promise<() => Promise<string>> {
	const connectState = await service.beginConnect(
		"tenant-a",
		"acme",
		"tenant-a-admin",
		BROWSER_NONCE,
	);
	return () => service.issueInstallationUrl(connectState, BROWSER_NONCE, RECONNECT_INITIATOR);
}

describe("GitHub outbound connection locking", () => {
	test("a confirmation holding the lock keeps the disconnect out until it commits", async () => {
		const pending = gate();
		const harness = lockHarness({
			initialTokenId: "tok-b",
			onPendingRead: () => pending.opened,
		});
		await db.insert(githubInstallations).values({
			tenantId: "tenant-a",
			installationId: 101,
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const startReconnect = await reconnectStarter(harness.service);
		const reconnect = startReconnect();
		let disconnect: Promise<void> = Promise.resolve();
		let confirming = false;
		let drainsWhileConfirming = 0;
		try {
			confirming = await waitFor(() => harness.pendingReads === 1);
			disconnect = harness.service.removeInstallation("tenant-a", 101, "tenant-a-admin");
			// Unserialized, the disconnect would drain the token this confirmation is
			// about to publish and leave a row naming a deleted credential. Waiting
			// for PostgreSQL to report the disconnect blocked on the lock — not a
			// fixed sleep — proves the two transactions actually contended.
			await waitForLockWaiter();
			drainsWhileConfirming = harness.drains;
		} finally {
			pending.release();
		}
		// Both operations are settled before anything is asserted, so a regression
		// reports a failure instead of stranding an open transaction.
		const [reconnected, disconnected] = await Promise.allSettled([reconnect, disconnect]);

		expect(confirming).toBe(true);
		expect(drainsWhileConfirming).toBe(0);
		expect(reconnected).toMatchObject({ status: "fulfilled" });
		expect(disconnected).toMatchObject({ status: "fulfilled" });
		// The disconnect drained exactly the generation the confirmation published.
		expect(harness.events).toEqual([
			"pending:enter",
			"pending:tok-b",
			"drain:enter:tok-b",
			"drain:done:tok-b",
		]);
		expect(await confirmedRows("tenant-a")).toEqual([]);
		expect(await harness.service.listInstallations("tenant-a")).toHaveLength(0);
		expect(harness.vault.size).toBe(0);
	});

	test("a disconnect holding the lock keeps a reconnect from confirming a token it is deleting", async () => {
		const drain = gate();
		const harness = lockHarness({ initialTokenId: "tok-a", onDrain: () => drain.opened });
		await bind(harness.service, "tenant-a", 101);
		expect(await confirmedRows("tenant-a")).toEqual(["tok-a"]);
		const readsBeforeDrain = harness.pendingReads;

		// Prepared before the disconnect launches and pauses on the drain gate: if
		// this DB work rejected afterward, the disconnect's already-open
		// transaction would have nothing to release it or settle it.
		const startReconnect = await reconnectStarter(harness.service);
		const disconnect = harness.service.removeInstallation("tenant-a", 101, "tenant-a-admin");
		let reconnect: Promise<string> | undefined;
		let draining = false;
		let readsWhileDraining = readsBeforeDrain;
		let settled: [PromiseSettledResult<string>, PromiseSettledResult<void>];
		try {
			draining = await waitFor(() => harness.drains === 1);
			reconnect = startReconnect();
			// Unserialized, the reconnect would read the vault here and confirm the
			// very token the drain is deleting. Waiting for PostgreSQL to report the
			// reconnect blocked on the lock — not a fixed sleep — proves the two
			// transactions actually contended.
			await waitForLockWaiter();
			readsWhileDraining = harness.pendingReads;
		} finally {
			drain.release();
			settled = await Promise.allSettled([
				reconnect ?? Promise.reject(new Error("reconnect never started")),
				disconnect,
			]);
		}
		const [reconnected, disconnected] = settled;

		expect(draining).toBe(true);
		expect(readsWhileDraining).toBe(readsBeforeDrain);
		expect(disconnected).toMatchObject({ status: "fulfilled" });
		expect(reconnected).toMatchObject({
			status: "rejected",
			reason: { code: "authorization_required" },
		});
		expect(harness.events.slice(-4)).toEqual([
			"drain:enter:tok-a",
			"drain:done:tok-a",
			"pending:enter",
			"pending:absent",
		]);
		expect(await confirmedRows("tenant-a")).toEqual([]);
		expect(await harness.service.listInstallations("tenant-a")).toHaveLength(0);
		expect(harness.vault.size).toBe(0);
	});

	test("a token vaulted while the disconnect holds the lock is confirmed and still exists", async () => {
		const drain = gate();
		const harness = lockHarness({
			initialTokenId: "tok-a",
			onDrain: () => drain.opened,
			// Descope finishes the reconnect's OAuth and vaults B right after the
			// drain emptied the slot, while the disconnect still owns the lock.
			afterDrain: (vault, slot) => vault.set(slot, "tok-b"),
		});
		await bind(harness.service, "tenant-a", 101);
		const readsBeforeDrain = harness.pendingReads;

		// Prepared before the disconnect launches and pauses on the drain gate, for
		// the same reason as the previous test.
		const startReconnect = await reconnectStarter(harness.service);
		const disconnect = harness.service.removeInstallation("tenant-a", 101, "tenant-a-admin");
		let reconnect: Promise<string> | undefined;
		let draining = false;
		let readsWhileDraining = readsBeforeDrain;
		let settled: [PromiseSettledResult<string>, PromiseSettledResult<void>];
		try {
			draining = await waitFor(() => harness.drains === 1);
			reconnect = startReconnect();
			await waitForLockWaiter();
			readsWhileDraining = harness.pendingReads;
		} finally {
			drain.release();
			settled = await Promise.allSettled([
				reconnect ?? Promise.reject(new Error("reconnect never started")),
				disconnect,
			]);
		}
		const [reconnected, disconnected] = settled;

		expect(draining).toBe(true);
		expect(readsWhileDraining).toBe(readsBeforeDrain);
		expect(disconnected).toMatchObject({ status: "fulfilled" });
		expect(reconnected).toMatchObject({ status: "fulfilled" });
		// The surviving confirmation names a token that is still in the vault, and
		// the drained generation left no row behind.
		expect(await confirmedRows("tenant-a")).toEqual(["tok-b"]);
		expect([...harness.vault.values()]).toEqual(["tok-b"]);
		expect(harness.events.slice(-4)).toEqual([
			"drain:enter:tok-a",
			"drain:done:tok-a",
			"pending:enter",
			"pending:tok-b",
		]);
	});
});

// ============================================================================
// Lock-ordered concurrency: installation callback versus disconnect
// ============================================================================
//
// Same idea, on the other half of the flow. The vault-backed service is the
// real one, so verification answers from the confirmation table and the vault
// exactly as it does in production; only its pauses are injected.

interface CallbackRaceHarness {
	readonly service: OctokitGitHubService;
	readonly events: string[];
	/** Set to a gate's promise to hold the next administration check open. */
	pauseVerification: Promise<void> | null;
	/** Set to a gate's promise to hold the next vault drain open. */
	pauseDrain: Promise<void> | null;
	verifications: number;
	drains: number;
}

/** Wraps the real vault-backed service so a test can pause it mid-call. */
function callbackRaceHarness(): CallbackRaceHarness {
	const delegate = vaultBackedOutbound();
	const events: string[] = [];
	const harness: CallbackRaceHarness = {
		service: undefined as unknown as OctokitGitHubService,
		events,
		pauseVerification: null,
		pauseDrain: null,
		verifications: 0,
		drains: 0,
	};

	harness.service = createService({
		outbound: {
			loadIdentity: (userId, tenantId) => delegate.loadIdentity(userId, tenantId),
			loadPendingConnection: (userId, tenantId) =>
				delegate.loadPendingConnection(userId, tenantId),
			verifyAccountAdministration: async (userId, tenantId, accountLogin, options) => {
				harness.verifications += 1;
				events.push("verify:enter");
				await harness.pauseVerification;
				try {
					await delegate.verifyAccountAdministration(userId, tenantId, accountLogin, options);
				} catch (error) {
					events.push("verify:denied");
					throw error;
				}
				events.push("verify:ok");
			},
			verifyInstallationAccess: (userId, tenantId, installationId) =>
				delegate.verifyInstallationAccess(userId, tenantId, installationId),
			drainTenantTokens: async (userId, tenantId, expectedTokenId) => {
				harness.drains += 1;
				events.push(`drain:enter:${expectedTokenId ?? "none"}`);
				await harness.pauseDrain;
				const cleared = await delegate.drainTenantTokens(userId, tenantId, expectedTokenId);
				events.push(`drain:done:${cleared.join(",") || "none"}`);
				return cleared;
			},
		},
	});
	return harness;
}

/**
 * The whole connection as an observer sees it. A binding with no confirmation
 * or no live token is the corruption these tests exist to rule out.
 */
async function connectionState(
	service: OctokitGitHubService,
	tenantId: string,
	userId: string,
): Promise<{ bindings: number[]; confirmed: string[]; vaulted: boolean }> {
	return {
		bindings: (await service.listInstallations(tenantId)).map((row) => row.installationId),
		confirmed: await confirmedRows(tenantId),
		vaulted: vaultTokens.has(vaultSlot(tenantId, userId)),
	};
}

describe("GitHub installation callback locking", () => {
	test("a callback holding the lock commits a whole connection before the disconnect runs", async () => {
		const harness = callbackRaceHarness();
		const installState = await issueInstallState(harness.service, "tenant-a", 101);
		const verification = gate();
		const drain = gate();
		harness.pauseVerification = verification.opened;
		harness.pauseDrain = drain.opened;
		const verificationsBefore = harness.verifications;

		const callback = harness.service.completeInstallation(installState, 101, BROWSER_NONCE);
		let disconnect: Promise<void> | undefined;
		let verifying = false;
		let draining = false;
		let drainsWhileVerifying = 0;
		let committed: { bindings: number[]; confirmed: string[]; vaulted: boolean } | undefined;
		let settled: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
		try {
			try {
				verifying = await waitFor(() => harness.verifications === verificationsBefore + 1);
				disconnect = harness.service.removeInstallation("tenant-a", 101, "tenant-a-admin");
				// Unserialized, the disconnect would delete the confirmation while this
				// callback is still verifying and about to save a binding. Waiting for
				// PostgreSQL to report the disconnect blocked on the lock — not a fixed
				// sleep — proves the two transactions actually contended.
				await waitForLockWaiter();
				drainsWhileVerifying = harness.drains;
			} finally {
				verification.release();
			}
			// The disconnect only reaches its drain once the callback committed, so
			// this snapshot is the state the callback published.
			draining = await waitFor(() => harness.drains === 1);
			committed = await connectionState(harness.service, "tenant-a", "tenant-a-admin");
		} finally {
			drain.release();
			settled = await Promise.allSettled([
				callback,
				disconnect ?? Promise.reject(new Error("disconnect never started")),
			]);
		}
		const [bound, disconnected] = settled;

		expect(verifying).toBe(true);
		expect(draining).toBe(true);
		expect(bound).toMatchObject({ status: "fulfilled", value: { installationId: 101 } });
		expect(disconnected).toMatchObject({ status: "fulfilled" });
		// Fully connected between the two commits: binding, confirmation, token.
		expect(committed).toEqual({
			bindings: [101],
			confirmed: [vaultTokenId("tenant-a", "tenant-a-admin")],
			vaulted: true,
		});
		// Fully disconnected afterwards.
		expect(await connectionState(harness.service, "tenant-a", "tenant-a-admin")).toEqual({
			bindings: [],
			confirmed: [],
			vaulted: false,
		});
		expect(drainsWhileVerifying).toBe(0);
	});

	test("a disconnect holding the lock keeps a callback from binding on a drained credential", async () => {
		const harness = callbackRaceHarness();
		const installState = await issueInstallState(harness.service, "tenant-a", 101);
		expect(await confirmedRows("tenant-a")).toEqual([
			vaultTokenId("tenant-a", "tenant-a-admin"),
		]);
		const drain = gate();
		harness.pauseDrain = drain.opened;
		const verificationsBefore = harness.verifications;

		const disconnect = harness.service.removeInstallation("tenant-a", 101, "tenant-a-admin");
		let callback: ReturnType<OctokitGitHubService["completeInstallation"]> | undefined;
		let draining = false;
		let verificationsWhileDraining = verificationsBefore;
		let settled: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
		try {
			draining = await waitFor(() => harness.drains === 1);
			callback = harness.service.completeInstallation(installState, 101, BROWSER_NONCE);
			// Unserialized, the callback would verify the credential this drain is
			// deleting and then save a binding with nothing behind it. Waiting for
			// PostgreSQL to report the callback blocked on the lock — not a fixed
			// sleep — proves the two transactions actually contended.
			await waitForLockWaiter();
			verificationsWhileDraining = harness.verifications;
		} finally {
			drain.release();
			settled = await Promise.allSettled([
				callback ?? Promise.reject(new Error("callback never started")),
				disconnect,
			]);
		}
		const [bound, disconnected] = settled;

		expect(draining).toBe(true);
		expect(disconnected).toMatchObject({ status: "fulfilled" });
		// The callback acquires the lock after the drain committed, finds no
		// confirmed credential, and rolls back without saving a binding.
		expect(bound).toMatchObject({
			status: "rejected",
			reason: { code: "authorization_required" },
		});
		expect(harness.events.slice(-3)).toEqual([
			"drain:done:" + vaultTokenId("tenant-a", "tenant-a-admin"),
			"verify:enter",
			"verify:denied",
		]);
		expect(await connectionState(harness.service, "tenant-a", "tenant-a-admin")).toEqual({
			bindings: [],
			confirmed: [],
			vaulted: false,
		});
		expect(verificationsWhileDraining).toBe(verificationsBefore);
	});
});
