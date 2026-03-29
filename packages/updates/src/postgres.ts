// @procella/updates — PostgreSQL implementation of UpdatesService.

import type { CryptoService } from "@procella/crypto";
import type { Database } from "@procella/db";
import { checkpoints, journalEntries, stacks, updateEvents, updates } from "@procella/db";
import type { BlobStorage } from "@procella/storage";
import {
	activeUpdatesGauge,
	checkpointSizeHistogram,
	journalEntriesCount,
	withDbSpan,
} from "@procella/telemetry";
import type {
	CompleteUpdateRequest,
	EngineEvent,
	EngineEventBatch,
	GetHistoryResponse,
	GetUpdateEventsResponse,
	ImportStackResponse,
	JournalEntries,
	JournalEntry,
	PatchUpdateCheckpointDeltaRequest,
	PatchUpdateCheckpointRequest,
	PatchUpdateVerbatimCheckpointRequest,
	RenewUpdateLeaseRequest,
	RenewUpdateLeaseResponse,
	ResourceV3,
	StartUpdateRequest,
	StartUpdateResponse,
	UntypedDeployment,
	UpdateInfo,
	UpdateProgramResponse,
	UpdateResults,
	UpdateStatus,
} from "@procella/types";
import {
	BadRequestError,
	CheckpointNotFoundError,
	JournalEntryBegin,
	JournalEntryFailure,
	JournalEntryOutputs,
	JournalEntryRebuiltBaseState,
	JournalEntryRefreshSuccess,
	JournalEntrySecretsManager,
	JournalEntrySuccess,
	JournalEntryWrite,
	LeaseExpiredError,
	UnauthorizedError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "@procella/types";
import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import { checkpointDedup } from "./checkpoint-dedup.js";
import type { TextEdit } from "./helpers.js";
import {
	applyTextEdits,
	emptyDeployment,
	formatBlobKey,
	generateLeaseToken,
	leaseExpiresAt,
	safeTokenCompare,
} from "./helpers.js";
import type { UpdatesService } from "./types.js";
import { BLOB_THRESHOLD, LEASE_DURATION_SECONDS } from "./types.js";

function pgErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let i = 0; i < 10 && current != null; i++) {
		if (typeof current === "object") {
			const rec = current as Record<string, unknown>;
			for (const key of ["code", "errno"] as const) {
				const val = rec[key];
				const str = typeof val === "number" ? String(val) : val;
				if (typeof str === "string" && /^[0-9A-Z]{5}$/i.test(str)) return str;
			}
			if (Array.isArray(rec.errors)) {
				for (const inner of rec.errors) {
					const found = pgErrorCode(inner);
					if (found) return found;
				}
			}
			if ("cause" in rec) {
				current = rec.cause;
				continue;
			}
		}
		current = undefined;
	}
	return undefined;
}

// ============================================================================
// PostgresUpdatesService
// ============================================================================

export class PostgresUpdatesService implements UpdatesService {
	private readonly db: Database;
	private readonly storage: BlobStorage;
	private readonly crypto: CryptoService;

	// Per-update caches for immutable/monotonic data. Cleared on completeUpdate/cancelUpdate.
	// Journal entries are NOT cached — DB remains source of truth for cluster safety.
	private static readonly MAX_CACHE_ENTRIES = 64;
	private readonly baseDeploymentCache = new Map<string, Record<string, unknown>>();
	private readonly checkpointVersionCache = new Map<string, number>();

	constructor({
		db,
		storage,
		crypto,
	}: { db: Database; storage: BlobStorage; crypto: CryptoService }) {
		this.db = db;
		this.storage = storage;
		this.crypto = crypto;
	}

	// ========================================================================
	// T8.2 — Core Lifecycle Methods
	// ========================================================================

	async createUpdate(
		stackId: string,
		kind: string,
		config?: unknown,
		program?: unknown,
	): Promise<UpdateProgramResponse> {
		return withDbSpan("createUpdate", { "update.kind": kind, "stack.id": stackId }, async () => {
			const [versionRow] = await this.db
				.select({ maxVersion: max(checkpoints.version) })
				.from(checkpoints)
				.where(eq(checkpoints.stackId, stackId));

			const version = (versionRow?.maxVersion ?? 0) + 1;

			try {
				const [row] = await this.db
					.insert(updates)
					.values({
						stackId,
						kind,
						status: "not started",
						version,
						config: config ?? null,
						program: program ?? null,
					})
					.returning();

				this.db.execute(sql`SELECT pg_notify('stack_updates', ${stackId})`).catch(() => {});

				return { updateID: row.id, version } as UpdateProgramResponse;
			} catch (err: unknown) {
				if (pgErrorCode(err) === "23505") {
					throw new UpdateConflictError(
						"Another update is already in progress for this stack. Run `pulumi cancel` to cancel it first.",
					);
				}
				throw err;
			}
		});
	}

	async startUpdate(updateId: string, request: StartUpdateRequest): Promise<StartUpdateResponse> {
		return withDbSpan("startUpdate", { "update.id": updateId }, async () => {
			let notifyStackId: string | undefined;
			const result = await this.db.transaction(async (tx) => {
				const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

				if (!row) {
					throw new UpdateNotFoundError(updateId);
				}

				if (row.status !== "not started") {
					throw new UpdateConflictError(
						`Update ${updateId} is in status "${row.status}", expected "not started"`,
					);
				}

				notifyStackId = row.stackId;
				const token = generateLeaseToken(updateId, row.stackId);
				const expiry = leaseExpiresAt();

				await tx
					.update(updates)
					.set({
						status: "running",
						leaseToken: token,
						leaseExpiresAt: expiry,
						startedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(eq(updates.id, updateId));

				await tx
					.update(stacks)
					.set({ activeUpdateId: updateId, updatedAt: sql`now()` })
					.where(eq(stacks.id, row.stackId));

				const journalVersion = (request.journalVersion ?? 0) >= 1 ? 1 : 0;

				return {
					token,
					version: row.version,
					tokenExpiration: Math.floor(expiry.getTime() / 1000),
					...(journalVersion > 0 ? { journalVersion } : {}),
				} as StartUpdateResponse;
			});
			activeUpdatesGauge().add(1);
			if (notifyStackId)
				this.db.execute(sql`SELECT pg_notify('stack_updates', ${notifyStackId})`).catch(() => {});
			return result;
		});
	}

	async verifyUpdateOwnership(updateId: string, stackId: string): Promise<void> {
		return withDbSpan("verifyUpdateOwnership", { "update.id": updateId }, async () => {
			const [row] = await this.db
				.select({ stackId: updates.stackId })
				.from(updates)
				.where(eq(updates.id, updateId));

			if (!row || row.stackId !== stackId) {
				throw new UpdateNotFoundError(updateId);
			}
		});
	}

	async verifyLeaseToken(updateId: string, token: string): Promise<void> {
		return withDbSpan("verifyLeaseToken", { "update.id": updateId }, async () => {
			const [row] = await this.db
				.select({ leaseToken: updates.leaseToken, leaseExpiresAt: updates.leaseExpiresAt })
				.from(updates)
				.where(eq(updates.id, updateId));

			if (!row?.leaseToken) {
				throw new UnauthorizedError("Invalid or expired update token");
			}

			if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() < Date.now()) {
				throw new UnauthorizedError("Update lease has expired");
			}

			if (!safeTokenCompare(row.leaseToken, token)) {
				throw new UnauthorizedError("Invalid update token");
			}
		});
	}

	async completeUpdate(updateId: string, request: CompleteUpdateRequest): Promise<void> {
		let notifyStackId: string | undefined;
		await withDbSpan(
			"completeUpdate",
			{ "update.id": updateId, "update.status": request.status },
			() =>
				this.db.transaction(async (tx) => {
					const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

					if (!row) {
						throw new UpdateNotFoundError(updateId);
					}

					if (row.status !== "running") {
						throw new UpdateConflictError(
							`Update ${updateId} is in status "${row.status}", expected "running"`,
						);
					}

					notifyStackId = row.stackId;

					await tx
						.update(updates)
						.set({
							status: request.status,
							result: request.status,
							completedAt: sql`now()`,
							leaseToken: null,
							leaseExpiresAt: null,
							updatedAt: sql`now()`,
						})
						.where(eq(updates.id, updateId));

					await tx
						.update(stacks)
						.set({ activeUpdateId: null, updatedAt: sql`now()` })
						.where(eq(stacks.id, row.stackId));
				}),
		);

		activeUpdatesGauge().add(-1);
		this.clearUpdateCaches(updateId);
		if (notifyStackId)
			this.db.execute(sql`SELECT pg_notify('stack_updates', ${notifyStackId})`).catch(() => {});
	}

	async cancelUpdate(updateId: string): Promise<void> {
		let notifyStackId: string | undefined;
		const wasRunning = await withDbSpan("cancelUpdate", { "update.id": updateId }, () =>
			this.db.transaction(async (tx) => {
				const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

				if (!row) {
					throw new UpdateNotFoundError(updateId);
				}

				if (row.status === "cancelled" || row.status === "succeeded" || row.status === "failed") {
					return false;
				}

				notifyStackId = row.stackId;
				const previouslyRunning = row.status === "running";

				await tx
					.update(updates)
					.set({
						status: "cancelled",
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: sql`now()`,
						updatedAt: sql`now()`,
					})
					.where(eq(updates.id, updateId));

				await tx
					.update(stacks)
					.set({ activeUpdateId: null, updatedAt: sql`now()` })
					.where(eq(stacks.id, row.stackId));

				return previouslyRunning;
			}),
		);

		if (wasRunning) {
			activeUpdatesGauge().add(-1);
		}
		this.clearUpdateCaches(updateId);
		if (notifyStackId)
			this.db.execute(sql`SELECT pg_notify('stack_updates', ${notifyStackId})`).catch(() => {});
	}

	async getUpdate(updateId: string): Promise<UpdateResults> {
		return withDbSpan("getUpdate", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			return {
				status: mapStatusToApiStatus(row.status) as UpdateStatus,
				events: [],
				continuationToken: undefined,
			} satisfies UpdateResults;
		});
	}

	async getHistory(stackId: string): Promise<GetHistoryResponse> {
		return withDbSpan("getHistory", { "stack.id": stackId }, async () => {
			const rows = await this.db
				.select()
				.from(updates)
				.where(eq(updates.stackId, stackId))
				.orderBy(desc(updates.createdAt));

			const updateList: UpdateInfo[] = rows.map(
				(row) =>
					({
						updateID: row.id,
						kind: row.kind,
						startTime: row.startedAt ? Math.floor(row.startedAt.getTime() / 1000) : 0,
						endTime: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : 0,
						version: row.version ?? 0,
						message: row.message ?? "",
						result: row.result ?? "",
						environment: {},
						config: (row.config ?? {}) as Record<string, unknown>,
						resourceChanges: {},
					}) as unknown as UpdateInfo,
			);

			return { updates: updateList } as GetHistoryResponse;
		});
	}

	// ========================================================================
	// T8.3 — Checkpoint, Event, and Lease Methods
	// ========================================================================

	async patchCheckpoint(updateId: string, request: PatchUpdateCheckpointRequest): Promise<void> {
		return withDbSpan("patchCheckpoint", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			const deployment = (request as { deployment?: unknown }).deployment;
			await this.upsertCheckpoint(updateId, row.stackId, deployment);
		});
	}

	async patchCheckpointVerbatim(
		updateId: string,
		request: PatchUpdateVerbatimCheckpointRequest,
	): Promise<void> {
		return withDbSpan("patchCheckpointVerbatim", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			const wrapper = (request as { untypedDeployment?: { deployment?: unknown } })
				.untypedDeployment;
			const rawDeployment = wrapper?.deployment ?? wrapper;
			await this.upsertCheckpoint(updateId, row.stackId, rawDeployment);
		});
	}

	async patchCheckpointDelta(
		updateId: string,
		request: PatchUpdateCheckpointDeltaRequest,
	): Promise<void> {
		return withDbSpan("patchCheckpointDelta", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			// Fetch latest non-delta checkpoint for this update
			const [baseCheckpoint] = await this.db
				.select()
				.from(checkpoints)
				.where(and(eq(checkpoints.updateId, updateId), eq(checkpoints.isDelta, false)))
				.orderBy(desc(checkpoints.version))
				.limit(1);

			let baseDeployment: unknown;
			if (baseCheckpoint) {
				if (baseCheckpoint.blobKey) {
					const data = await this.storage.get(baseCheckpoint.blobKey);
					if (!data) {
						throw new Error("Checkpoint blob data missing from storage");
					}
					baseDeployment = JSON.parse(new TextDecoder().decode(data));
				} else {
					baseDeployment = baseCheckpoint.data;
				}
			} else {
				baseDeployment = {};
			}

			const baseJson = JSON.stringify(baseDeployment);

			const edits = (request as { deploymentDelta?: unknown }).deploymentDelta;
			if (!Array.isArray(edits)) {
				throw new BadRequestError("deploymentDelta must be an array of TextEdit");
			}

			const newJson = applyTextEdits(baseJson, edits as TextEdit[]);

			const expectedHash = (request as { checkpointHash?: string }).checkpointHash;
			if (expectedHash) {
				const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(newJson));
				const actualHash = Array.from(new Uint8Array(hashBuffer))
					.map((b) => b.toString(16).padStart(2, "0"))
					.join("");
				if (actualHash !== expectedHash) {
					throw new BadRequestError(
						`Checkpoint hash mismatch: expected ${expectedHash}, got ${actualHash}`,
					);
				}
			}

			const merged = JSON.parse(newJson);
			await this.upsertCheckpoint(updateId, row.stackId, merged);
		});
	}

	async appendJournalEntries(updateId: string, batch: JournalEntries): Promise<void> {
		return withDbSpan("appendJournalEntries", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			const entries = batch.entries ?? [];
			if (entries.length === 0) {
				return;
			}

			const rows = entries.map((entry: JournalEntry) => {
				if (
					typeof entry.sequenceID !== "number" ||
					typeof entry.operationID !== "number" ||
					typeof entry.kind !== "number"
				) {
					throw new BadRequestError(
						"Invalid journal entry: sequenceID, operationID, and kind must be numbers",
					);
				}
				return {
					updateId,
					stackId: row.stackId,
					sequenceId: BigInt(entry.sequenceID),
					operationId: BigInt(entry.operationID),
					kind: entry.kind,
					state: entry.state ?? null,
					operation: entry.operation ?? null,
					secretsProvider: entry.secretsProvider ?? null,
					newSnapshot: entry.newSnapshot ?? null,
					operationType: null,
					removeOld: entry.removeOld != null ? BigInt(entry.removeOld) : null,
					removeNew: entry.removeNew != null ? BigInt(entry.removeNew) : null,
					elideWrite: entry.elideWrite ?? false,
				};
			});

			await this.db.insert(journalEntries).values(rows).onConflictDoNothing();
			journalEntriesCount().add(entries.length, { "update.id": updateId });

			const hasNonElided = entries.some((e: JournalEntry) => !e.elideWrite);
			if (hasNonElided) {
				await this.flushJournalToCheckpoint(updateId, row.stackId);
			}
		});
	}

	async postEvents(updateId: string, batch: EngineEventBatch): Promise<void> {
		const events = (batch as { events?: EngineEvent[] }).events;
		if (!events || events.length === 0) {
			return;
		}

		return withDbSpan(
			"postEvents",
			{ "update.id": updateId, "events.count": events.length },
			async () => {
				const rows = events.map((event) => ({
					updateId,
					sequence: (event as { sequence?: number }).sequence ?? 0,
					kind: detectEventKind(event),
					fields: event as unknown,
				}));

				await this.db
					.insert(updateEvents)
					.values(rows)
					.onConflictDoUpdate({
						target: [updateEvents.updateId, updateEvents.sequence],
						set: { kind: sql`excluded.kind`, fields: sql`excluded.fields` },
					});

				this.db.execute(sql`SELECT pg_notify('update_events', ${updateId})`).catch(() => {});
			},
		);
	}

	async getUpdateEvents(
		updateId: string,
		continuationToken?: string,
	): Promise<GetUpdateEventsResponse> {
		return withDbSpan("getUpdateEvents", { "update.id": updateId }, async () => {
			const lastSeq = continuationToken ? Number.parseInt(continuationToken, 10) : 0;

			const rows = await this.db
				.select()
				.from(updateEvents)
				.where(and(eq(updateEvents.updateId, updateId), gt(updateEvents.sequence, lastSeq)))
				.orderBy(updateEvents.sequence);

			const eventsList = rows.map((row) => row.fields as EngineEvent);

			// Check if update is still running
			const [update] = await this.db
				.select({ status: updates.status })
				.from(updates)
				.where(eq(updates.id, updateId));

			const isTerminal =
				update?.status === "succeeded" ||
				update?.status === "failed" ||
				update?.status === "cancelled";

			let nextToken: string | undefined;
			if (rows.length > 0 && !isTerminal) {
				nextToken = String(rows[rows.length - 1].sequence);
			}

			return {
				events: eventsList,
				continuationToken: nextToken,
			} as unknown as GetUpdateEventsResponse;
		});
	}

	async renewLease(
		updateId: string,
		request: RenewUpdateLeaseRequest,
	): Promise<RenewUpdateLeaseResponse> {
		return withDbSpan("renewLease", { "update.id": updateId }, async () => {
			const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			if (!row.leaseToken) {
				throw new LeaseExpiredError();
			}

			if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() < Date.now()) {
				throw new LeaseExpiredError();
			}

			const duration = (request as { duration?: number }).duration ?? LEASE_DURATION_SECONDS;
			const newExpiry = leaseExpiresAt(duration);

			await this.db
				.update(updates)
				.set({ leaseExpiresAt: newExpiry, updatedAt: sql`now()` })
				.where(eq(updates.id, updateId));

			return {
				token: row.leaseToken,
				tokenExpiration: Math.floor(newExpiry.getTime() / 1000),
			} as RenewUpdateLeaseResponse;
		});
	}

	// ========================================================================
	// T8.4 — State Operations + Crypto Methods
	// ========================================================================

	async exportStack(stackId: string, version?: number): Promise<UntypedDeployment> {
		return withDbSpan("exportStack", { "stack.id": stackId }, async () => {
			let checkpoint: typeof checkpoints.$inferSelect | undefined;

			if (version !== undefined) {
				const rows = await this.db
					.select()
					.from(checkpoints)
					.where(and(eq(checkpoints.stackId, stackId), eq(checkpoints.version, version)))
					.orderBy(desc(checkpoints.version))
					.limit(1);
				checkpoint = rows[0];
				if (!checkpoint) {
					throw new CheckpointNotFoundError("", "", `version ${version}`);
				}
			} else {
				const rows = await this.db
					.select()
					.from(checkpoints)
					.where(and(eq(checkpoints.stackId, stackId), eq(checkpoints.isDelta, false)))
					.orderBy(desc(checkpoints.createdAt))
					.limit(1);
				checkpoint = rows[0];
				if (!checkpoint) {
					return emptyDeployment();
				}
			}

			let deploymentData: unknown;
			if (checkpoint.blobKey) {
				const data = await this.storage.get(checkpoint.blobKey);
				if (!data) {
					throw new Error("Checkpoint blob data missing from storage");
				}
				deploymentData = JSON.parse(new TextDecoder().decode(data));
			} else {
				deploymentData = checkpoint.data;
			}

			return {
				version: 3,
				deployment: deploymentData,
			} as UntypedDeployment;
		});
	}

	async importStack(stackId: string, deployment: UntypedDeployment): Promise<ImportStackResponse> {
		return withDbSpan("importStack", { "stack.id": stackId }, async () => {
			const [updateRow] = await this.db
				.insert(updates)
				.values({
					stackId,
					kind: "import",
					status: "succeeded",
					completedAt: sql`now()`,
				})
				.returning();

			await this.upsertCheckpoint(updateRow.id, stackId, deployment.deployment);

			return { updateId: updateRow.id } satisfies ImportStackResponse;
		});
	}

	async encryptValue(stackFQN: string, plaintext: Uint8Array): Promise<Uint8Array> {
		return this.crypto.encrypt(plaintext, stackFQN);
	}

	async decryptValue(stackFQN: string, ciphertext: Uint8Array): Promise<Uint8Array> {
		return this.crypto.decrypt(ciphertext, stackFQN);
	}

	async batchEncrypt(stackFQN: string, plaintexts: Uint8Array[]): Promise<Uint8Array[]> {
		return Promise.all(plaintexts.map((p) => this.crypto.encrypt(p, stackFQN)));
	}

	async batchDecrypt(stackFQN: string, ciphertexts: Uint8Array[]): Promise<Uint8Array[]> {
		return Promise.all(ciphertexts.map((c) => this.crypto.decrypt(c, stackFQN)));
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	private async nextCheckpointVersion(updateId: string): Promise<number> {
		this.evictStaleCaches();

		const cached = this.checkpointVersionCache.get(updateId);
		if (cached !== undefined) {
			const next = cached + 1;
			this.checkpointVersionCache.set(updateId, next);
			return next;
		}

		const [row] = await this.db
			.select({ maxVersion: max(checkpoints.version) })
			.from(checkpoints)
			.where(eq(checkpoints.updateId, updateId));

		const next = (row?.maxVersion ?? 0) + 1;
		this.checkpointVersionCache.set(updateId, next);
		return next;
	}

	private clearUpdateCaches(updateId: string): void {
		this.baseDeploymentCache.delete(updateId);
		this.checkpointVersionCache.delete(updateId);
		checkpointDedup.clear(updateId);
	}

	private evictStaleCaches(): void {
		if (this.baseDeploymentCache.size > PostgresUpdatesService.MAX_CACHE_ENTRIES) {
			this.baseDeploymentCache.clear();
		}
		if (this.checkpointVersionCache.size > PostgresUpdatesService.MAX_CACHE_ENTRIES) {
			this.checkpointVersionCache.clear();
		}
	}

	private async flushJournalToCheckpoint(updateId: string, stackId: string): Promise<void> {
		return withDbSpan("flushJournalToCheckpoint", { "update.id": updateId }, async () => {
			const allEntries = await this.db
				.select()
				.from(journalEntries)
				.where(eq(journalEntries.updateId, updateId))
				.orderBy(journalEntries.sequenceId);

			if (allEntries.length === 0) {
				return;
			}

			let baseDeployment = this.baseDeploymentCache.get(updateId);
			if (!baseDeployment) {
				baseDeployment = await this.loadBaseDeploymentForUpdate(stackId, updateId);
				this.baseDeploymentCache.set(updateId, baseDeployment);
			}

			const reconstructed = applyJournalEntries(baseDeployment, allEntries);
			await this.upsertCheckpoint(updateId, stackId, reconstructed);
		});
	}

	private async upsertCheckpoint(updateId: string, stackId: string, data: unknown): Promise<void> {
		return withDbSpan(
			"upsertCheckpoint",
			{ "update.id": updateId, "stack.id": stackId },
			async () => {
				const serialized = JSON.stringify(data);

				if (await checkpointDedup.isDuplicate(updateId, serialized)) {
					return;
				}

				checkpointSizeHistogram().record(Buffer.byteLength(serialized, "utf8"), {
					"stack.id": stackId,
				});
				const version = await this.nextCheckpointVersion(updateId);

				let blobKey: string | null = null;
				const checkpointData: unknown = data;
				if (serialized.length > BLOB_THRESHOLD) {
					blobKey = formatBlobKey(stackId, updateId, version);
					await this.storage.put(blobKey, new TextEncoder().encode(serialized));
					await this.db
						.insert(checkpoints)
						.values({
							updateId,
							stackId,
							version,
							data: null,
							blobKey,
							isDelta: false,
						})
						.onConflictDoUpdate({
							target: [checkpoints.updateId, checkpoints.version],
							set: { data: null, blobKey, isDelta: false },
						});
					return;
				}

				await this.db
					.insert(checkpoints)
					.values({
						updateId,
						stackId,
						version,
						data: checkpointData,
						blobKey,
						isDelta: false,
					})
					.onConflictDoUpdate({
						target: [checkpoints.updateId, checkpoints.version],
						set: {
							data: checkpointData,
							blobKey,
							isDelta: false,
						},
					});
			},
		);
	}

	private async loadBaseDeploymentForUpdate(
		stackId: string,
		updateId: string,
	): Promise<Record<string, unknown>> {
		const [initial] = await this.db
			.select()
			.from(checkpoints)
			.where(and(eq(checkpoints.updateId, updateId), eq(checkpoints.isDelta, false)))
			.orderBy(asc(checkpoints.version))
			.limit(1);

		const row =
			initial ??
			(await this.db
				.select()
				.from(checkpoints)
				.where(and(eq(checkpoints.stackId, stackId), eq(checkpoints.isDelta, false)))
				.orderBy(desc(checkpoints.createdAt))
				.limit(1)
				.then((rows) => rows[0]));

		if (!row) {
			return {
				manifest: { time: new Date().toISOString(), magic: "", version: "" },
				secrets_providers: { type: "passphrase", state: {} },
				resources: [],
				pending_operations: [],
			};
		}

		if (row.blobKey) {
			const raw = await this.storage.get(row.blobKey);
			if (!raw) {
				throw new Error("Checkpoint blob data missing from storage");
			}
			return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
		}

		return (row.data as Record<string, unknown>) ?? {};
	}
}

// ============================================================================
// Pure Helpers (exported for testing)
// ============================================================================

/** Map DB status string to Pulumi API status string. */
export function mapStatusToApiStatus(dbStatus: string): string {
	switch (dbStatus) {
		case "not started":
			return "not-started";
		case "requested":
			return "not-started";
		case "running":
			return "in-progress";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		default:
			return dbStatus;
	}
}

export interface JournalRow {
	kind: number;
	operationId: number | bigint;
	state: unknown;
	operation: unknown;
	secretsProvider: unknown;
	newSnapshot: unknown;
	operationType: string | null;
	removeOld: bigint | null;
	removeNew: bigint | null;
	elideWrite: boolean;
}

export function applyJournalEntries(
	baseDeployment: Record<string, unknown>,
	entries: JournalRow[],
): Record<string, unknown> {
	let deployment = { ...baseDeployment };

	// URN-based resource map for entries without index pointers (httpstate CLI)
	const resourcesByUrn = new Map<string, ResourceV3>();
	for (const r of (deployment.resources ?? []) as ResourceV3[]) {
		resourcesByUrn.set(r.urn, r);
	}

	const newResources: Array<ResourceV3 | null> = [];
	const opIdToNewIdx = new Map<string, number>();
	const toDeleteInSnapshot = new Set<number>();
	const toReplaceInSnapshot = new Map<number, ResourceV3>();

	for (const entry of entries) {
		const opKey = String(entry.operationId);
		const state = entry.state as ResourceV3 | null | undefined;

		switch (entry.kind) {
			case JournalEntryWrite: {
				const snap = entry.newSnapshot as Record<string, unknown> | null;
				if (snap) {
					deployment = { ...snap };
					resourcesByUrn.clear();
					for (const r of (deployment.resources ?? []) as ResourceV3[]) {
						resourcesByUrn.set(r.urn, r);
					}
				}
				break;
			}

			case JournalEntrySecretsManager: {
				const sp = entry.secretsProvider as { type: string; state: unknown } | null;
				if (sp) {
					deployment.secrets_providers = sp;
				}
				break;
			}

			case JournalEntryBegin: {
				if (state) {
					const idx = newResources.length;
					newResources.push(null);
					opIdToNewIdx.set(opKey, idx);
				}
				break;
			}

			case JournalEntrySuccess: {
				const hasIndexPointers = entry.removeOld != null || entry.removeNew != null;
				if (hasIndexPointers) {
					if (entry.removeOld != null && state) {
						toReplaceInSnapshot.set(Number(entry.removeOld), state);
					} else if (entry.removeOld != null && !state) {
						const baseRes = ((deployment.resources ?? []) as ResourceV3[])[Number(entry.removeOld)];
						if (baseRes) resourcesByUrn.delete(baseRes.urn);
						toDeleteInSnapshot.add(Number(entry.removeOld));
					}
					if (entry.removeNew != null && state) {
						const idx = opIdToNewIdx.get(String(entry.removeNew));
						if (idx !== undefined) newResources[idx] = state;
					} else if (entry.removeNew != null && !state) {
						const idx = opIdToNewIdx.get(String(entry.removeNew));
						if (idx !== undefined) newResources[idx] = null;
					}
				} else if (state) {
					// No index pointers (httpstate CLI) — fall back to URN-based tracking
					if ((state as { delete?: boolean }).delete) {
						resourcesByUrn.delete(state.urn);
					} else {
						resourcesByUrn.set(state.urn, state);
					}
				}
				break;
			}

			case JournalEntryFailure: {
				break;
			}

			case JournalEntryRefreshSuccess: {
				if (entry.removeOld != null) {
					if (state) {
						toReplaceInSnapshot.set(Number(entry.removeOld), state);
					} else {
						toDeleteInSnapshot.add(Number(entry.removeOld));
					}
				}
				if (entry.removeNew != null) {
					const idx = opIdToNewIdx.get(String(entry.removeNew));
					if (idx !== undefined) {
						newResources[idx] = state ?? null;
					}
				}
				break;
			}

			case JournalEntryOutputs: {
				if (state && entry.removeOld != null) {
					toReplaceInSnapshot.set(Number(entry.removeOld), state);
				} else if (state && entry.removeNew != null) {
					const idx = opIdToNewIdx.get(String(entry.removeNew));
					if (idx !== undefined) newResources[idx] = state;
				} else if (state) {
					// No index pointers — URN-based update
					resourcesByUrn.set(state.urn, state);
				}
				break;
			}

			case JournalEntryRebuiltBaseState: {
				const rebuilt = rebuildFromJournal(
					deployment,
					newResources,
					toDeleteInSnapshot,
					toReplaceInSnapshot,
					resourcesByUrn,
				);
				deployment = rebuilt;
				newResources.length = 0;
				opIdToNewIdx.clear();
				toDeleteInSnapshot.clear();
				toReplaceInSnapshot.clear();
				resourcesByUrn.clear();
				for (const r of (deployment.resources ?? []) as ResourceV3[]) {
					resourcesByUrn.set(r.urn, r);
				}
				break;
			}

			default:
				break;
		}
	}

	return rebuildFromJournal(
		deployment,
		newResources,
		toDeleteInSnapshot,
		toReplaceInSnapshot,
		resourcesByUrn,
	);
}

function rebuildFromJournal(
	base: Record<string, unknown>,
	newResources: Array<ResourceV3 | null>,
	toDelete: Set<number>,
	toReplace: Map<number, ResourceV3>,
	resourcesByUrn: Map<string, ResourceV3>,
): Record<string, unknown> {
	const baseResources = ((base.resources ?? []) as ResourceV3[]).slice();

	for (const [idx, replacement] of toReplace) {
		if (idx >= 0 && idx < baseResources.length) {
			baseResources[idx] = replacement;
		}
	}

	const filtered = baseResources.filter((_, i) => !toDelete.has(i));
	const indexAdded = newResources.filter((r): r is ResourceV3 => r != null);

	// When index pointers were used, index-based reconstruction is authoritative.
	// URN-based map only adds resources that aren't already in the index-based result.
	const hasIndexOps = toDelete.size > 0 || toReplace.size > 0 || indexAdded.length > 0;
	const merged = new Map<string, ResourceV3>();
	if (hasIndexOps) {
		for (const r of filtered) merged.set(r.urn, r);
		for (const r of indexAdded) merged.set(r.urn, r);
		// Add URN-based resources that don't conflict with index results
		for (const [urn, r] of resourcesByUrn) {
			if (!merged.has(urn)) merged.set(urn, r);
		}
	} else {
		// Pure URN-based mode (httpstate CLI)
		for (const [urn, r] of resourcesByUrn) merged.set(urn, r);
	}

	return {
		...base,
		resources: Array.from(merged.values()),
		pending_operations: [],
	};
}

/** Detect the event kind from an EngineEvent by checking which field is non-null. */
export function detectEventKind(event: EngineEvent): string {
	const e = event as unknown as Record<string, unknown>;
	if (e.cancelEvent) return "cancel";
	if (e.stdoutEvent) return "stdout";
	if (e.diagnosticEvent) return "diagnostic";
	if (e.preludeEvent) return "prelude";
	if (e.summaryEvent) return "summary";
	if (e.resourcePreEvent) return "resource-pre";
	if (e.resOutputsEvent) return "res-outputs";
	if (e.resOpFailedEvent) return "res-op-failed";
	if (e.policyEvent) return "policy";
	if (e.errorEvent) return "error";
	if (e.progressEvent) return "progress";
	return "unknown";
}
