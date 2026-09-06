import { randomUUID } from "node:crypto";
import type { Database } from "@procella/db";
import { blobCleanupQueue } from "@procella/db";
import type { BlobStorage } from "@procella/storage";
import { and, eq, sql } from "drizzle-orm";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_PER_RUN = 100;
const CLAIM_SECONDS = 300;
const MIN_WORK_BUDGET_MS = 1_000;
const MAX_RETRY_DELAY_SECONDS = 1_024;
const MAX_ERROR_LENGTH = 500;

interface BlobCleanupClaim {
	id: string;
	blobKey: string;
	attempts: number;
}

export class BlobCleanupWorker {
	private readonly db: Database;
	private readonly storage: BlobStorage;
	private readonly interval: number;
	private readonly maxPerRun: number;
	private readonly workerId: string;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor({
		db,
		storage,
		interval,
		maxPerRun,
		workerId,
		now,
	}: {
		db: Database;
		storage: BlobStorage;
		interval?: number;
		maxPerRun?: number;
		workerId?: string;
		now?: () => number;
	}) {
		this.db = db;
		this.storage = storage;
		this.interval = interval ?? DEFAULT_INTERVAL_MS;
		this.maxPerRun = maxPerRun ?? DEFAULT_MAX_PER_RUN;
		this.workerId = workerId ?? randomUUID();
		this.now = now ?? Date.now;
	}

	async start(): Promise<void> {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runCycle().catch((error) => console.error("[blob-cleanup] cycle failed", error));
		}, this.interval);
		await this.runCycle().catch((error) => console.error("[blob-cleanup] cycle failed", error));
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		while (this.running) await Bun.sleep(25);
	}

	async runOnce({ deadlineMs }: { deadlineMs?: number } = {}): Promise<number> {
		return this.runCycle(deadlineMs);
	}

	private async runCycle(deadlineMs?: number): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let deleted = 0;
		try {
			for (let index = 0; index < this.maxPerRun; index += 1) {
				if (deadlineMs !== undefined && deadlineMs - this.now() < MIN_WORK_BUDGET_MS) break;
				const claim = await this.claimNext();
				if (!claim) break;
				try {
					await this.storage.delete(claim.blobKey);
					if (await this.ack(claim)) deleted += 1;
				} catch (error) {
					await this.retry(claim, error);
				}
			}
			return deleted;
		} finally {
			this.running = false;
		}
	}

	private async claimNext(): Promise<BlobCleanupClaim | null> {
		return this.db.transaction(async (tx) => {
			const result = await tx.execute(sql`
				WITH candidate AS (
					SELECT id
					FROM blob_cleanup_queue
					WHERE available_at <= now()
						AND (claimed_until IS NULL OR claimed_until < now())
					ORDER BY created_at, id
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				), claimed AS (
					UPDATE blob_cleanup_queue queue
					SET claimed_by = ${this.workerId}::uuid,
						claimed_until = now() + (${CLAIM_SECONDS} * interval '1 second'),
						attempts = queue.attempts + 1,
						updated_at = now()
					FROM candidate
					WHERE queue.id = candidate.id
					RETURNING queue.id, queue.blob_key AS "blobKey", queue.attempts
				)
				SELECT * FROM claimed
			`);
			const rows = Array.isArray(result)
				? result
				: typeof result === "object" && result !== null && "rows" in result
					? result.rows
					: null;
			if (!Array.isArray(rows)) throw new Error("Unexpected database execute result shape");
			return (rows as BlobCleanupClaim[])[0] ?? null;
		});
	}

	private async ack(claim: BlobCleanupClaim): Promise<boolean> {
		const rows = await this.db
			.delete(blobCleanupQueue)
			.where(and(eq(blobCleanupQueue.id, claim.id), eq(blobCleanupQueue.claimedBy, this.workerId)))
			.returning({ id: blobCleanupQueue.id });
		return rows.length > 0;
	}

	private async retry(claim: BlobCleanupClaim, error: unknown): Promise<void> {
		const delaySeconds = Math.min(
			MAX_RETRY_DELAY_SECONDS,
			2 ** Math.min(Math.max(claim.attempts - 1, 0), 10),
		);
		const message = sanitizeBlobCleanupError(error);
		await this.db
			.update(blobCleanupQueue)
			.set({
				claimedBy: null,
				claimedUntil: null,
				availableAt: sql`now() + (${delaySeconds} * interval '1 second')`,
				lastError: message,
				updatedAt: sql`now()`,
			})
			.where(and(eq(blobCleanupQueue.id, claim.id), eq(blobCleanupQueue.claimedBy, this.workerId)));
	}
}

function sanitizeBlobCleanupError(error: unknown): string {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return message
		.replace(/authorization["']?\s*[:=]\s*[^\r\n,}]+/gi, "authorization=[redacted]")
		.replace(/(token|secret|private[-_ ]?key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]")
		.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
		.slice(0, MAX_ERROR_LENGTH);
}
