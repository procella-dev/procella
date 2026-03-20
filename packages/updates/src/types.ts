// @procella/updates — Service interface, types, and constants.

import type {
	CompleteUpdateRequest,
	EngineEventBatch,
	GetHistoryResponse,
	GetUpdateEventsResponse,
	ImportStackResponse,
	JournalEntries,
	PatchUpdateCheckpointDeltaRequest,
	PatchUpdateCheckpointRequest,
	PatchUpdateVerbatimCheckpointRequest,
	RenewUpdateLeaseRequest,
	RenewUpdateLeaseResponse,
	StartUpdateRequest,
	StartUpdateResponse,
	UntypedDeployment,
	UpdateProgramResponse,
	UpdateResults,
} from "@procella/types";

// ============================================================================
// UpdatesService Interface
// ============================================================================

export interface UpdatesService {
	createUpdate(
		stackId: string,
		kind: string,
		config?: unknown,
		program?: unknown,
	): Promise<UpdateProgramResponse>;

	startUpdate(updateId: string, request: StartUpdateRequest): Promise<StartUpdateResponse>;

	completeUpdate(updateId: string, request: CompleteUpdateRequest): Promise<void>;

	cancelUpdate(updateId: string): Promise<void>;

	patchCheckpoint(updateId: string, request: PatchUpdateCheckpointRequest): Promise<void>;

	patchCheckpointVerbatim(
		updateId: string,
		request: PatchUpdateVerbatimCheckpointRequest,
	): Promise<void>;

	patchCheckpointDelta(updateId: string, request: PatchUpdateCheckpointDeltaRequest): Promise<void>;

	appendJournalEntries(updateId: string, entries: JournalEntries): Promise<void>;

	postEvents(updateId: string, batch: EngineEventBatch): Promise<void>;

	renewLease(updateId: string, request: RenewUpdateLeaseRequest): Promise<RenewUpdateLeaseResponse>;

	getUpdate(updateId: string): Promise<UpdateResults>;

	getUpdateEvents(updateId: string, continuationToken?: string): Promise<GetUpdateEventsResponse>;

	getHistory(stackId: string): Promise<GetHistoryResponse>;

	exportStack(stackId: string, version?: number): Promise<UntypedDeployment>;

	importStack(stackId: string, deployment: UntypedDeployment): Promise<ImportStackResponse>;

	encryptValue(stackFQN: string, plaintext: Uint8Array): Promise<Uint8Array>;

	decryptValue(stackFQN: string, ciphertext: Uint8Array): Promise<Uint8Array>;

	batchEncrypt(stackFQN: string, plaintexts: Uint8Array[]): Promise<Uint8Array[]>;

	batchDecrypt(stackFQN: string, ciphertexts: Uint8Array[]): Promise<Uint8Array[]>;
}

// ============================================================================
// Constants
// ============================================================================

/** Checkpoint data larger than this is stored in blob storage. */
export const BLOB_THRESHOLD = 1_048_576; // 1 MB

/** Default update lease duration in seconds. */
export const LEASE_DURATION_SECONDS = 300; // 5 minutes

/** GC worker scan interval in milliseconds. */
export const GC_INTERVAL_MS = 60_000; // 60 seconds

/** Updates older than this without activity are considered stale. */
export const GC_STALE_THRESHOLD_MS = 3_600_000; // 1 hour

/** PostgreSQL advisory lock ID for cluster-safe GC. */
export const GC_ADVISORY_LOCK_ID = 93_874_835_275_587n; // 0x5472617461_4743 (historic, do not change)

// ============================================================================
// Internal Row Types (mirror DB schema for type-safe mapping)
// ============================================================================

export interface UpdateRow {
	id: string;
	stackId: string;
	kind: string;
	status: string;
	result: string | null;
	message: string | null;
	version: number;
	leaseToken: string | null;
	leaseExpiresAt: Date | null;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	config: unknown;
	program: unknown;
}

export interface CheckpointRow {
	id: string;
	updateId: string;
	stackId: string;
	version: number;
	data: unknown;
	blobKey: string | null;
	isDelta: boolean;
	createdAt: Date;
}

export interface UpdateEventRow {
	id: string;
	updateId: string;
	sequence: number;
	kind: string;
	fields: unknown;
	createdAt: Date;
}
