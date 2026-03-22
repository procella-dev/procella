// @procella/updates — PostgreSQL implementation of UpdatesService.

import type { CryptoService } from "@procella/crypto";
import type { Database } from "@procella/db";
import { checkpoints, journalEntries, stacks, updateEvents, updates } from "@procella/db";
import type { BlobStorage } from "@procella/storage";
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
	UpdateConflictError,
	UpdateNotFoundError,
} from "@procella/types";
import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import {
	applyDelta,
	emptyDeployment,
	formatBlobKey,
	generateLeaseToken,
	leaseExpiresAt,
} from "./helpers.js";
import type { UpdatesService } from "./types.js";
import { BLOB_THRESHOLD, LEASE_DURATION_SECONDS } from "./types.js";

// ============================================================================
// PostgresUpdatesService
// ============================================================================

export class PostgresUpdatesService implements UpdatesService {
	private readonly db: Database;
	private readonly storage: BlobStorage;
	private readonly crypto: CryptoService;

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
		// Get next version from existing checkpoints
		const [versionRow] = await this.db
			.select({ maxVersion: max(checkpoints.version) })
			.from(checkpoints)
			.where(eq(checkpoints.stackId, stackId));

		const version = (versionRow?.maxVersion ?? 0) + 1;

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

		return { updateID: row.id, version } as UpdateProgramResponse;
	}

	async startUpdate(updateId: string, request: StartUpdateRequest): Promise<StartUpdateResponse> {
		return this.db.transaction(async (tx) => {
			const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			if (row.status !== "not started") {
				throw new UpdateConflictError(
					`Update ${updateId} is in status "${row.status}", expected "not started"`,
				);
			}

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
	}

	async completeUpdate(updateId: string, request: CompleteUpdateRequest): Promise<void> {
		await this.db.transaction(async (tx) => {
			const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			if (row.status !== "running") {
				throw new UpdateConflictError(
					`Update ${updateId} is in status "${row.status}", expected "running"`,
				);
			}

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
		});
	}

	async cancelUpdate(updateId: string): Promise<void> {
		await this.db.transaction(async (tx) => {
			const [row] = await tx.select().from(updates).where(eq(updates.id, updateId));

			if (!row) {
				throw new UpdateNotFoundError(updateId);
			}

			// Idempotent: already terminal → no-op
			if (row.status === "cancelled" || row.status === "succeeded" || row.status === "failed") {
				return;
			}

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
		});
	}

	async getUpdate(updateId: string): Promise<UpdateResults> {
		const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

		if (!row) {
			throw new UpdateNotFoundError(updateId);
		}

		return {
			status: mapStatusToApiStatus(row.status) as UpdateStatus,
			events: [],
			continuationToken: undefined,
		} satisfies UpdateResults;
	}

	async getHistory(stackId: string): Promise<GetHistoryResponse> {
		const rows = await this.db
			.select()
			.from(updates)
			.where(eq(updates.stackId, stackId))
			.orderBy(desc(updates.createdAt));

		const updateList: UpdateInfo[] = rows.map(
			(row) =>
				({
					kind: row.kind,
					startTime: row.startedAt?.getTime() ?? 0,
					message: row.message ?? "",
					result: row.result ?? "",
					environment: {},
					config: (row.config ?? {}) as Record<string, unknown>,
					resourceChanges: {},
				}) as UpdateInfo,
		);

		return { updates: updateList } as GetHistoryResponse;
	}

	// ========================================================================
	// T8.3 — Checkpoint, Event, and Lease Methods
	// ========================================================================

	async patchCheckpoint(updateId: string, request: PatchUpdateCheckpointRequest): Promise<void> {
		const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

		if (!row) {
			throw new UpdateNotFoundError(updateId);
		}

		const deployment = (request as { deployment?: unknown }).deployment;
		const serialized = JSON.stringify(deployment);
		const version = await this.nextCheckpointVersion(updateId);

		if (serialized.length > BLOB_THRESHOLD) {
			const blobKey = formatBlobKey(row.stackId, updateId, version);
			await this.storage.put(blobKey, new TextEncoder().encode(serialized));
			await this.db.insert(checkpoints).values({
				updateId,
				stackId: row.stackId,
				version,
				data: null,
				blobKey,
				isDelta: false,
			});
		} else {
			await this.db.insert(checkpoints).values({
				updateId,
				stackId: row.stackId,
				version,
				data: deployment,
				blobKey: null,
				isDelta: false,
			});
		}
	}

	async patchCheckpointVerbatim(
		updateId: string,
		request: PatchUpdateVerbatimCheckpointRequest,
	): Promise<void> {
		const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

		if (!row) {
			throw new UpdateNotFoundError(updateId);
		}

		// Verbatim: untypedDeployment is the full UntypedDeployment wrapper { version, deployment }.
		// Extract the inner deployment to store consistently with patchCheckpoint.
		const wrapper = (request as { untypedDeployment?: { deployment?: unknown } }).untypedDeployment;
		const rawDeployment = wrapper?.deployment ?? wrapper;
		const serialized = JSON.stringify(rawDeployment);
		const version = await this.nextCheckpointVersion(updateId);

		if (serialized.length > BLOB_THRESHOLD) {
			const blobKey = formatBlobKey(row.stackId, updateId, version);
			await this.storage.put(blobKey, new TextEncoder().encode(serialized));
			await this.db.insert(checkpoints).values({
				updateId,
				stackId: row.stackId,
				version,
				data: null,
				blobKey,
				isDelta: false,
			});
		} else {
			await this.db.insert(checkpoints).values({
				updateId,
				stackId: row.stackId,
				version,
				data: rawDeployment,
				blobKey: null,
				isDelta: false,
			});
		}
	}

	async patchCheckpointDelta(
		updateId: string,
		request: PatchUpdateCheckpointDeltaRequest,
	): Promise<void> {
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

		// Apply delta merge patch
		const delta = (request as { deployment?: unknown }).deployment;
		const merged = applyDelta(baseDeployment, delta);
		const serialized = JSON.stringify(merged);
		const version = await this.nextCheckpointVersion(updateId);

		if (serialized.length > BLOB_THRESHOLD) {
			const blobKey = formatBlobKey(row.stackId, updateId, version);
			await this.storage.put(blobKey, new TextEncoder().encode(serialized));
			await this.db.insert(checkpoints).values({
				updateId,
				stackId: row.stackId,
				version,
				data: null,
				blobKey,
				isDelta: false,
			});
		} else {
			await this.db.insert(checkpoints).values({
				updateId,
				stackId: row.stackId,
				version,
				data: merged,
				blobKey: null,
				isDelta: false,
			});
		}
	}

	async appendJournalEntries(updateId: string, batch: JournalEntries): Promise<void> {
		const [row] = await this.db.select().from(updates).where(eq(updates.id, updateId));

		if (!row) {
			throw new UpdateNotFoundError(updateId);
		}

		const entries = batch.entries ?? [];
		if (entries.length === 0) {
			return;
		}

		// biome-ignore lint/suspicious/noConsole: temporary debug for CI E2E failure
		for (const e of entries) {
			console.log(
				`[journal-entry] kind=${e.kind} opId=${e.operationID} seqId=${e.sequenceID} hasState=${!!e.state} removeOld=${e.removeOld} removeNew=${e.removeNew} hasSnapshot=${!!e.newSnapshot} hasSP=${!!e.secretsProvider} elide=${e.elideWrite}`,
			);
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

		const hasNonElided = entries.some((e: JournalEntry) => !e.elideWrite);
		if (hasNonElided) {
			await this.flushJournalToCheckpoint(updateId, row.stackId);
		}
	}

	async postEvents(updateId: string, batch: EngineEventBatch): Promise<void> {
		const events = (batch as { events?: EngineEvent[] }).events;
		if (!events || events.length === 0) {
			return;
		}

		const rows = events.map((event) => ({
			updateId,
			sequence: (event as { sequence?: number }).sequence ?? 0,
			kind: detectEventKind(event),
			fields: event as unknown,
		}));

		await this.db.insert(updateEvents).values(rows);
	}

	async getUpdateEvents(
		updateId: string,
		continuationToken?: string,
	): Promise<GetUpdateEventsResponse> {
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
	}

	async renewLease(
		updateId: string,
		request: RenewUpdateLeaseRequest,
	): Promise<RenewUpdateLeaseResponse> {
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
	}

	// ========================================================================
	// T8.4 — State Operations + Crypto Methods
	// ========================================================================

	async exportStack(stackId: string, version?: number): Promise<UntypedDeployment> {
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
	}

	async importStack(stackId: string, deployment: UntypedDeployment): Promise<ImportStackResponse> {
		// Single-shot import (no create→start→complete lifecycle)
		const [updateRow] = await this.db
			.insert(updates)
			.values({
				stackId,
				kind: "import",
				status: "succeeded",
				completedAt: sql`now()`,
			})
			.returning();

		// Get next version
		const [versionRow] = await this.db
			.select({ maxVersion: max(checkpoints.version) })
			.from(checkpoints)
			.where(eq(checkpoints.stackId, stackId));

		const version = (versionRow?.maxVersion ?? 0) + 1;
		const serialized = JSON.stringify(deployment.deployment);

		if (serialized.length > BLOB_THRESHOLD) {
			const blobKey = formatBlobKey(stackId, updateRow.id, version);
			await this.storage.put(blobKey, new TextEncoder().encode(serialized));
			await this.db.insert(checkpoints).values({
				updateId: updateRow.id,
				stackId,
				version,
				data: null,
				blobKey,
				isDelta: false,
			});
		} else {
			await this.db.insert(checkpoints).values({
				updateId: updateRow.id,
				stackId,
				version,
				data: deployment.deployment,
				blobKey: null,
				isDelta: false,
			});
		}

		return { updateId: updateRow.id } satisfies ImportStackResponse;
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
		const [row] = await this.db
			.select({ maxVersion: max(checkpoints.version) })
			.from(checkpoints)
			.where(eq(checkpoints.updateId, updateId));

		return (row?.maxVersion ?? 0) + 1;
	}

	private async flushJournalToCheckpoint(updateId: string, stackId: string): Promise<void> {
		const allEntries = await this.db
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.updateId, updateId))
			.orderBy(journalEntries.sequenceId);

		if (allEntries.length === 0) {
			return;
		}

		const baseDeployment = await this.loadBaseDeploymentForUpdate(stackId, updateId);
		const reconstructed = applyJournalEntries(baseDeployment, allEntries);
		const serialized = JSON.stringify(reconstructed);
		const maxAttempts = 5;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const version = await this.nextCheckpointVersion(updateId);
			try {
				if (serialized.length > BLOB_THRESHOLD) {
					const blobKey = formatBlobKey(stackId, updateId, version);
					await this.storage.put(blobKey, new TextEncoder().encode(serialized));
					await this.db.insert(checkpoints).values({
						updateId,
						stackId,
						version,
						data: null,
						blobKey,
						isDelta: false,
					});
				} else {
					await this.db.insert(checkpoints).values({
						updateId,
						stackId,
						version,
						data: reconstructed,
						blobKey: null,
						isDelta: false,
					});
				}
				return;
			} catch (error: unknown) {
				const err = error as { code?: string };
				if (err.code === "23505" && attempt < maxAttempts - 1) {
					continue;
				}
				throw error;
			}
		}
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
				if (entry.removeOld != null && state) {
					toReplaceInSnapshot.set(Number(entry.removeOld), state);
				} else if (entry.removeOld != null && !state) {
					toDeleteInSnapshot.add(Number(entry.removeOld));
				}
				if (entry.removeNew != null && state) {
					const idx = opIdToNewIdx.get(String(entry.removeNew));
					if (idx !== undefined) newResources[idx] = state;
				} else if (entry.removeNew != null && !state) {
					const idx = opIdToNewIdx.get(String(entry.removeNew));
					if (idx !== undefined) newResources[idx] = null;
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
				}
				if (state && entry.removeNew != null) {
					const idx = opIdToNewIdx.get(String(entry.removeNew));
					if (idx !== undefined) newResources[idx] = state;
				}
				break;
			}

			case JournalEntryRebuiltBaseState: {
				const rebuilt = rebuildFromJournal(
					deployment,
					newResources,
					toDeleteInSnapshot,
					toReplaceInSnapshot,
				);
				deployment = rebuilt;
				newResources.length = 0;
				opIdToNewIdx.clear();
				toDeleteInSnapshot.clear();
				toReplaceInSnapshot.clear();
				break;
			}

			default:
				break;
		}
	}

	return rebuildFromJournal(deployment, newResources, toDeleteInSnapshot, toReplaceInSnapshot);
}

function rebuildFromJournal(
	base: Record<string, unknown>,
	newResources: Array<ResourceV3 | null>,
	toDelete: Set<number>,
	toReplace: Map<number, ResourceV3>,
): Record<string, unknown> {
	const baseResources = ((base.resources ?? []) as ResourceV3[]).slice();

	for (const [idx, replacement] of toReplace) {
		if (idx >= 0 && idx < baseResources.length) {
			baseResources[idx] = replacement;
		}
	}

	const filtered = baseResources.filter((_, i) => !toDelete.has(i));
	const added = newResources.filter((r): r is ResourceV3 => r != null);

	return {
		...base,
		resources: [...filtered, ...added],
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
