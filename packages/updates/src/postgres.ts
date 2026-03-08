// @strata/updates — PostgreSQL implementation of UpdatesService.

import type { CryptoService } from "@strata/crypto";
import type { Database } from "@strata/db";
import { checkpoints, stacks, updateEvents, updates } from "@strata/db";
import type { BlobStorage } from "@strata/storage";
import type {
	CompleteUpdateRequest,
	EngineEvent,
	EngineEventBatch,
	GetHistoryResponse,
	GetUpdateEventsResponse,
	ImportStackResponse,
	PatchUpdateCheckpointDeltaRequest,
	PatchUpdateCheckpointRequest,
	PatchUpdateVerbatimCheckpointRequest,
	RenewUpdateLeaseRequest,
	RenewUpdateLeaseResponse,
	StartUpdateRequest,
	StartUpdateResponse,
	UntypedDeployment,
	UpdateInfo,
	UpdateProgramResponse,
	UpdateResults,
	UpdateStatus,
} from "@strata/types";
import {
	CheckpointNotFoundError,
	LeaseExpiredError,
	UpdateConflictError,
	UpdateNotFoundError,
} from "@strata/types";
import { and, desc, eq, gt, max, sql } from "drizzle-orm";
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
	}: {
		db: Database;
		storage: BlobStorage;
		crypto: CryptoService;
	}) {
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

	async startUpdate(updateId: string, _request: StartUpdateRequest): Promise<StartUpdateResponse> {
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

			return {
				token,
				version: row.version,
				tokenExpiration: Math.floor(expiry.getTime() / 1000),
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
					throw new CheckpointNotFoundError("", "", "");
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
				throw new CheckpointNotFoundError("", "", "");
			}
		} else {
			const rows = await this.db
				.select()
				.from(checkpoints)
				.where(and(eq(checkpoints.stackId, stackId), eq(checkpoints.isDelta, false)))
				.orderBy(desc(checkpoints.version))
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
				throw new CheckpointNotFoundError("", "", "");
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
