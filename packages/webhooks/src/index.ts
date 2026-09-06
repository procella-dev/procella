import { type Database, webhookDeliveries, webhookOutbox, webhooks } from "@procella/db";
import { NotFoundError } from "@procella/types";
import { and, desc, eq, sql } from "drizzle-orm";
import { resolveAndValidateUrl, validateUrl } from "./url-validator.js";

export {
	isBlockedHostname,
	isPrivateIp,
	resolveAndValidateUrl,
	validateUrl,
} from "./url-validator.js";

export function validateWebhookUrl(url: string): void {
	validateUrl(url, "Webhook");
}

export async function resolveAndValidateWebhookUrl(url: string): Promise<void> {
	await resolveAndValidateUrl(url, "Webhook");
}

export const WebhookEvent = {
	STACK_CREATED: "stack.created",
	STACK_DELETED: "stack.deleted",
	STACK_UPDATED: "stack.updated",
	UPDATE_STARTED: "update.started",
	UPDATE_SUCCEEDED: "update.succeeded",
	UPDATE_FAILED: "update.failed",
	UPDATE_CANCELLED: "update.cancelled",
} as const;

export type WebhookEventValue = (typeof WebhookEvent)[keyof typeof WebhookEvent];
export const ALL_WEBHOOK_EVENTS = Object.values(WebhookEvent);

export interface WebhookInfo {
	id: string;
	name: string;
	url: string;
	events: string[];
	active: boolean;
	createdBy: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface WebhookDeliveryInfo {
	id: string;
	event: string;
	responseStatus: number | null;
	success: boolean;
	attempt: number;
	error: string | null;
	duration: number | null;
	createdAt: Date;
}

export interface CreateWebhookInput {
	name: string;
	url: string;
	events: string[];
	secret?: string;
}

export interface WebhooksService {
	createWebhook(
		tenantId: string,
		input: CreateWebhookInput,
		createdBy: string,
	): Promise<WebhookInfo & { secret: string }>;
	listWebhooks(tenantId: string): Promise<WebhookInfo[]>;
	getWebhook(tenantId: string, webhookId: string): Promise<WebhookInfo | null>;
	updateWebhook(
		tenantId: string,
		webhookId: string,
		updates: Partial<CreateWebhookInput>,
	): Promise<WebhookInfo>;
	deleteWebhook(tenantId: string, webhookId: string): Promise<void>;
	listDeliveries(
		tenantId: string,
		webhookId: string,
		limit?: number,
	): Promise<WebhookDeliveryInfo[]>;
	/**
	 * Persist one delivery intent per subscribed webhook. Delivery itself is performed
	 * later by {@link WebhookOutboxWorker}, so callers get at-least-once semantics that
	 * survive a crash between the database commit and the outbound HTTP request.
	 */
	enqueue(intent: WebhookIntent): Promise<void>;
	ping(tenantId: string, webhookId: string): Promise<WebhookDeliveryInfo>;
}

export async function signPayload(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

type WebhookRow = typeof webhooks.$inferSelect;

export interface WebhookIntent {
	tenantId: string;
	event: WebhookEventValue;
	data: Record<string, unknown>;
}

type WebhookEnqueueDatabase = Pick<Database, "execute">;

/** Enqueue one immutable delivery per matching webhook using the caller's transaction. */
export async function enqueueWebhookEvent(
	db: WebhookEnqueueDatabase,
	intent: WebhookIntent,
): Promise<void> {
	const body = JSON.stringify({
		event: intent.event,
		timestamp: new Date().toISOString(),
		data: intent.data,
	});
	await db.execute(sql`
		INSERT INTO webhook_outbox (webhook_id, tenant_id, url, secret, event, body)
		SELECT id, tenant_id, url, secret, ${intent.event}, ${body}
		FROM webhooks
		WHERE tenant_id = ${intent.tenantId}
			AND active = true
			AND ${intent.event} = ANY(events)
	`);
}

export class PostgresWebhooksService implements WebhooksService {
	private readonly db: Database;

	constructor({ db }: { db: Database }) {
		this.db = db;
	}

	async createWebhook(
		tenantId: string,
		input: CreateWebhookInput,
		createdBy: string,
	): Promise<WebhookInfo & { secret: string }> {
		await resolveAndValidateWebhookUrl(input.url);
		const secret = input.secret ?? crypto.randomUUID();
		const [row] = await this.db
			.insert(webhooks)
			.values({
				tenantId,
				name: input.name,
				url: input.url,
				secret,
				events: input.events,
				createdBy,
			})
			.returning();

		return {
			...this.toWebhookInfo(row),
			secret: row.secret,
		};
	}

	async listWebhooks(tenantId: string): Promise<WebhookInfo[]> {
		const rows = await this.db
			.select()
			.from(webhooks)
			.where(eq(webhooks.tenantId, tenantId))
			.orderBy(desc(webhooks.createdAt));

		return rows.map((row) => this.toWebhookInfo(row));
	}

	async getWebhook(tenantId: string, webhookId: string): Promise<WebhookInfo | null> {
		const [row] = await this.db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, webhookId)))
			.limit(1);

		if (!row) {
			return null;
		}

		return this.toWebhookInfo(row);
	}

	async updateWebhook(
		tenantId: string,
		webhookId: string,
		updates: Partial<CreateWebhookInput>,
	): Promise<WebhookInfo> {
		const patch: Partial<typeof webhooks.$inferInsert> = {
			updatedAt: new Date(),
		};

		if (typeof updates.name === "string") patch.name = updates.name;
		if (typeof updates.url === "string") {
			await resolveAndValidateWebhookUrl(updates.url);
			patch.url = updates.url;
		}
		if (Array.isArray(updates.events)) patch.events = updates.events;
		if (typeof updates.secret === "string") patch.secret = updates.secret;

		const [row] = await this.db
			.update(webhooks)
			.set(patch)
			.where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, webhookId)))
			.returning();

		if (!row) {
			throw new NotFoundError("Webhook", webhookId);
		}

		return this.toWebhookInfo(row);
	}

	async deleteWebhook(tenantId: string, webhookId: string): Promise<void> {
		const result = await this.db
			.delete(webhooks)
			.where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, webhookId)));

		if (result.rowCount === 0) {
			throw new NotFoundError("Webhook", webhookId);
		}
	}

	async listDeliveries(
		tenantId: string,
		webhookId: string,
		limit = 50,
	): Promise<WebhookDeliveryInfo[]> {
		const [hook] = await this.db
			.select({ id: webhooks.id })
			.from(webhooks)
			.where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, webhookId)))
			.limit(1);

		if (!hook) {
			throw new NotFoundError("Webhook", webhookId);
		}

		const rows = await this.db
			.select({
				id: webhookDeliveries.id,
				event: webhookDeliveries.event,
				responseStatus: webhookDeliveries.responseStatus,
				success: webhookDeliveries.success,
				attempt: webhookDeliveries.attempt,
				error: webhookDeliveries.error,
				duration: webhookDeliveries.duration,
				createdAt: webhookDeliveries.createdAt,
			})
			.from(webhookDeliveries)
			.innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
			.where(and(eq(webhooks.tenantId, tenantId), eq(webhookDeliveries.webhookId, webhookId)))
			.orderBy(desc(webhookDeliveries.createdAt))
			.limit(limit);

		return rows.map((row) => ({
			id: row.id,
			event: row.event,
			responseStatus: row.responseStatus,
			success: row.success,
			attempt: row.attempt,
			error: row.error,
			duration: row.duration,
			createdAt: row.createdAt,
		}));
	}

	async enqueue(intent: WebhookIntent): Promise<void> {
		await enqueueWebhookEvent(this.db, intent);
	}

	async ping(tenantId: string, webhookId: string): Promise<WebhookDeliveryInfo> {
		const [webhook] = await this.db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, webhookId)))
			.limit(1);

		if (!webhook) {
			throw new NotFoundError("Webhook", webhookId);
		}

		const id = await this.dispatchOnce(webhook, "webhook.ping", {
			message: "Webhook ping",
			tenantId,
			webhookId,
		});

		const [row] = await this.db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, id))
			.limit(1);

		if (!row) {
			throw new NotFoundError("WebhookDelivery", id);
		}

		return {
			id: row.id,
			event: row.event,
			responseStatus: row.responseStatus,
			success: row.success,
			attempt: row.attempt,
			error: row.error,
			duration: row.duration,
			createdAt: row.createdAt,
		};
	}

	private async dispatchOnce(
		webhook: WebhookRow,
		event: string,
		payload: Record<string, unknown>,
	): Promise<string> {
		try {
			await resolveAndValidateWebhookUrl(webhook.url);
		} catch (err) {
			return this.recordDelivery({
				webhookId: webhook.id,
				event,
				payload,
				requestHeaders: null,
				responseStatus: null,
				responseBody: null,
				responseHeaders: null,
				success: false,
				attempt: 1,
				error: err instanceof Error ? err.message : "Invalid webhook URL",
				duration: 0,
			});
		}
		const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
		const signature = await signPayload(body, webhook.secret);
		const start = Date.now();
		const requestHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			"X-Webhook-Signature": `sha256=${signature}`,
			"X-Webhook-Event": event,
			"X-Webhook-Id": webhook.id,
			"User-Agent": "Procella-Webhooks/1.0",
		};

		try {
			const resp = await fetch(webhook.url, {
				method: "POST",
				headers: requestHeaders,
				body,
				signal: AbortSignal.timeout(10_000),
				redirect: "manual",
			});
			const duration = Date.now() - start;
			const responseBody = await resp.text().catch(() => "");
			const responseHeaders = Object.fromEntries(resp.headers.entries());
			return this.recordDelivery({
				webhookId: webhook.id,
				event,
				payload: JSON.parse(body) as Record<string, unknown>,
				requestHeaders,
				responseStatus: resp.status,
				responseBody: responseBody.slice(0, 1024),
				responseHeaders,
				duration,
				attempt: 1,
				success: resp.ok,
				error: null,
			});
		} catch (error: unknown) {
			const duration = Date.now() - start;
			return this.recordDelivery({
				webhookId: webhook.id,
				event,
				payload: JSON.parse(body) as Record<string, unknown>,
				requestHeaders,
				responseStatus: null,
				responseBody: null,
				responseHeaders: null,
				duration,
				attempt: 1,
				success: false,
				error: String(error),
			});
		}
	}

	private async recordDelivery(input: {
		webhookId: string;
		event: string;
		payload: Record<string, unknown>;
		requestHeaders: Record<string, string> | null;
		responseStatus: number | null;
		responseBody: string | null;
		responseHeaders: Record<string, string> | null;
		duration: number;
		attempt: number;
		success: boolean;
		error: string | null;
	}): Promise<string> {
		const [row] = await this.db
			.insert(webhookDeliveries)
			.values({
				webhookId: input.webhookId,
				event: input.event,
				payload: input.payload,
				requestHeaders: input.requestHeaders,
				responseStatus: input.responseStatus,
				responseBody: input.responseBody,
				responseHeaders: input.responseHeaders,
				duration: input.duration,
				attempt: input.attempt,
				success: input.success,
				error: input.error,
			})
			.returning({ id: webhookDeliveries.id });

		return row.id;
	}

	private toWebhookInfo(row: WebhookRow): WebhookInfo {
		return {
			id: row.id,
			name: row.name,
			url: row.url,
			events: row.events,
			active: row.active,
			createdBy: row.createdBy,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}
}

export const WEBHOOK_OUTBOX_CLAIM_SECONDS = 120;
export const WEBHOOK_OUTBOX_MAX_ATTEMPTS = 8;
export const WEBHOOK_OUTBOX_POLL_INTERVAL_MS = 5_000;
/** Never start an attempt that cannot finish its 10s request before a scheduled runtime's deadline. */
const WEBHOOK_OUTBOX_MIN_DELIVERY_BUDGET_MS = 12_000;

interface WebhookOutboxClaim {
	id: string;
	webhookId: string;
	event: string;
	url: string;
	secret: string;
	body: string;
	attempts: number;
}

interface DeliveryResult {
	requestHeaders: Record<string, string> | null;
	responseStatus: number | null;
	responseBody: string | null;
	responseHeaders: Record<string, string> | null;
	duration: number;
	success: boolean;
	error: string | null;
}

class PermanentWebhookDeliveryError extends Error {
	constructor(
		message: string,
		readonly result: DeliveryResult,
	) {
		super(message);
	}
}

/**
 * Drains `webhook_outbox`. Every replica may run one: claims are leased with
 * `FOR UPDATE SKIP LOCKED` and every state change is fenced on `claimed_by`, so two workers
 * never deliver the same intent concurrently and a stolen lease can never retire an intent.
 */
export class WebhookOutboxWorker {
	private readonly db: Database;
	private readonly workerId: string;
	private readonly interval: number;
	private readonly maxPerRun: number;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor({
		db,
		workerId,
		interval,
		maxPerRun = 25,
		fetcher = fetch,
		now = Date.now,
	}: {
		db: Database;
		workerId?: string;
		interval?: number;
		maxPerRun?: number;
		fetcher?: typeof fetch;
		now?: () => number;
	}) {
		this.db = db;
		this.workerId = workerId ?? crypto.randomUUID();
		this.interval = interval ?? WEBHOOK_OUTBOX_POLL_INTERVAL_MS;
		this.maxPerRun = maxPerRun;
		this.fetcher = fetcher;
		this.now = now;
	}

	async start(): Promise<void> {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runCycle().catch((error) => console.error("[webhook-outbox] cycle failed", error));
		}, this.interval);
		await this.runCycle().catch((error) => console.error("[webhook-outbox] cycle failed", error));
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
	}

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
					deadlineMs - this.now() < WEBHOOK_OUTBOX_MIN_DELIVERY_BUDGET_MS
				) {
					break;
				}
				const claim = await this.claimNext();
				if (!claim) break;
				try {
					const result = await this.deliver(claim);
					if (await this.settle(claim, result, false)) delivered += 1;
				} catch (error) {
					const permanent = error instanceof PermanentWebhookDeliveryError;
					const result = permanent
						? error.result
						: failedDeliveryResult(error instanceof Error ? error.message : String(error));
					await this.settle(claim, result, permanent);
				}
			}
			return delivered;
		} finally {
			this.running = false;
		}
	}

	private async claimNext(): Promise<WebhookOutboxClaim | null> {
		return this.db.transaction(async (tx) => {
			const result = await tx.execute(sql`
				WITH candidate AS (
					SELECT id
					FROM webhook_outbox
					WHERE failed_at IS NULL
						AND available_at <= now()
						AND (claimed_until IS NULL OR claimed_until < now())
					ORDER BY created_at, id
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				), claimed AS (
					UPDATE webhook_outbox outbox
					SET claimed_by = ${this.workerId}::uuid,
						claimed_until = now() + (${WEBHOOK_OUTBOX_CLAIM_SECONDS} * interval '1 second'),
						attempts = outbox.attempts + 1,
						updated_at = now()
					FROM candidate
					WHERE outbox.id = candidate.id
					RETURNING outbox.*
				)
				SELECT id, webhook_id AS "webhookId", event, url, secret, body, attempts FROM claimed
			`);
			return executeRows<WebhookOutboxClaim>(result)[0] ?? null;
		});
	}

	private async deliver(claim: WebhookOutboxClaim): Promise<DeliveryResult> {
		const startedAt = this.now();
		try {
			await resolveAndValidateWebhookUrl(claim.url);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid webhook URL";
			throw new PermanentWebhookDeliveryError(message, {
				...failedDeliveryResult(message),
				duration: this.now() - startedAt,
			});
		}

		const signature = await signPayload(claim.body, claim.secret);
		const requestHeaders = deliveryHeaders(claim, signature);
		try {
			const response = await this.fetcher(claim.url, {
				method: "POST",
				headers: requestHeaders,
				body: claim.body,
				signal: AbortSignal.timeout(10_000),
				redirect: "manual",
			});
			return {
				requestHeaders,
				responseStatus: response.status,
				responseBody: (await response.text().catch(() => "")).slice(0, 1024),
				responseHeaders: Object.fromEntries(response.headers.entries()),
				duration: this.now() - startedAt,
				success: response.ok,
				error: null,
			};
		} catch (error) {
			return {
				...failedDeliveryResult(error instanceof Error ? error.message : String(error)),
				requestHeaders,
				duration: this.now() - startedAt,
			};
		}
	}

	/**
	 * Fence on the claim before recording anything: a worker whose lease was stolen must not
	 * retire the intent. A successful delivery removes the row, so the queue stays bounded and
	 * `webhook_deliveries` remains the delivery history of record.
	 */
	private async settle(
		claim: WebhookOutboxClaim,
		result: DeliveryResult,
		permanent: boolean,
	): Promise<boolean> {
		const terminal =
			!result.success &&
			(permanent ||
				isPermanentStatus(result.responseStatus) ||
				claim.attempts >= WEBHOOK_OUTBOX_MAX_ATTEMPTS);
		const delay = webhookRetryDelaySeconds(claim.attempts);
		const error = sanitizeWebhookError(
			result.error ?? `Webhook endpoint returned HTTP ${result.responseStatus}`,
		);
		const fence = and(eq(webhookOutbox.id, claim.id), eq(webhookOutbox.claimedBy, this.workerId));

		return this.db.transaction(async (tx) => {
			const owned = result.success
				? await tx.delete(webhookOutbox).where(fence).returning({ id: webhookOutbox.id })
				: await tx
						.update(webhookOutbox)
						.set({
							claimedBy: null,
							claimedUntil: null,
							lastError: error,
							updatedAt: sql`now()`,
							...(terminal
								? { failedAt: sql`now()` }
								: { availableAt: sql`now() + (${delay} * interval '1 second')` }),
						})
						.where(fence)
						.returning({ id: webhookOutbox.id });
			if (owned.length === 0) return false;

			await tx.insert(webhookDeliveries).values({
				webhookId: claim.webhookId,
				event: claim.event,
				payload: JSON.parse(claim.body) as Record<string, unknown>,
				requestHeaders: result.requestHeaders,
				responseStatus: result.responseStatus,
				responseBody: result.responseBody,
				responseHeaders: result.responseHeaders,
				duration: result.duration,
				attempt: claim.attempts,
				success: result.success,
				error: result.success ? null : error,
			});
			return result.success;
		});
	}
}

/**
 * Byte-for-byte the header set the legacy in-process dispatcher sent, plus `X-Webhook-Delivery`:
 * the outbox row id, which is stable across retries and is the identifier consumers deduplicate on.
 */
function deliveryHeaders(claim: WebhookOutboxClaim, signature: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"X-Webhook-Signature": `sha256=${signature}`,
		"X-Webhook-Event": claim.event,
		"X-Webhook-Id": claim.webhookId,
		"X-Webhook-Delivery": claim.id,
		"User-Agent": "Procella-Webhooks/1.0",
	};
}

/** 4xx other than timeout/rate-limit means the request itself is wrong; retrying cannot fix it. */
function isPermanentStatus(status: number | null): boolean {
	if (status === null) return false;
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function failedDeliveryResult(error: string): DeliveryResult {
	return {
		requestHeaders: null,
		responseStatus: null,
		responseBody: null,
		responseHeaders: null,
		duration: 0,
		success: false,
		error,
	};
}

export function webhookRetryDelaySeconds(attempts: number): number {
	return Math.min(900, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

function sanitizeWebhookError(error: unknown): string {
	return String(error ?? "Webhook delivery failed")
		.replace(/[\r\n\t]+/g, " ")
		.slice(0, 1024);
}

function executeRows<T>(result: unknown): T[] {
	if (Array.isArray(result)) return result as T[];
	if (
		typeof result === "object" &&
		result !== null &&
		"rows" in result &&
		Array.isArray(result.rows)
	) {
		return result.rows as T[];
	}
	throw new Error("Unexpected database execute result shape");
}
