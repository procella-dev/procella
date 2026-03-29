import { type Database, webhookDeliveries, webhooks } from "@procella/db";
import { BadRequestError, NotFoundError } from "@procella/types";
import { and, desc, eq } from "drizzle-orm";

// ============================================================================
// SSRF Protection
// ============================================================================

const PRIVATE_IP_PATTERNS = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^169\.254\./,
	/^0\./,
	/^::1$/,
	/^fc00:/i,
	/^fe80:/i,
	/^fd[0-9a-f]{2}:/i,
];

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
	"169.254.169.254",
	"[::1]",
]);

export function validateWebhookUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BadRequestError("Invalid webhook URL");
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new BadRequestError("Webhook URL must use HTTP or HTTPS");
	}

	const hostname = parsed.hostname.toLowerCase();
	if (BLOCKED_HOSTNAMES.has(hostname)) {
		throw new BadRequestError("Webhook URL cannot target private or metadata addresses");
	}

	for (const pattern of PRIVATE_IP_PATTERNS) {
		if (pattern.test(hostname)) {
			throw new BadRequestError("Webhook URL cannot target private or reserved IP addresses");
		}
	}
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
	emit(event: { tenantId: string; event: WebhookEventValue; data: Record<string, unknown> }): void;
	emitAndWait(event: {
		tenantId: string;
		event: WebhookEventValue;
		data: Record<string, unknown>;
	}): Promise<void>;
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
		validateWebhookUrl(input.url);
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
			validateWebhookUrl(updates.url);
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

	emit(event: { tenantId: string; event: WebhookEventValue; data: Record<string, unknown> }): void {
		void this.emitAsync(event).catch((error: unknown) => {
			console.error("[webhooks] Failed to emit event", {
				tenantId: event.tenantId,
				event: event.event,
				error,
			});
		});
	}

	async emitAndWait(event: {
		tenantId: string;
		event: WebhookEventValue;
		data: Record<string, unknown>;
	}): Promise<void> {
		await this.emitAsync(event);
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

	private async emitAsync(event: {
		tenantId: string;
		event: WebhookEventValue;
		data: Record<string, unknown>;
	}): Promise<void> {
		const rows = await this.db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.tenantId, event.tenantId), eq(webhooks.active, true)));

		const filtered = rows.filter((row) => row.events.includes(event.event));
		if (filtered.length === 0) {
			return;
		}

		await Promise.all(filtered.map((row) => this.dispatch(row, event.event, event.data)));
	}

	private async dispatch(
		webhook: WebhookRow,
		event: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		validateWebhookUrl(webhook.url);
		const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload });
		const signature = await signPayload(body, webhook.secret);

		const maxAttempts = 3;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const start = Date.now();
			try {
				const requestHeaders: Record<string, string> = {
					"Content-Type": "application/json",
					"X-Webhook-Signature": `sha256=${signature}`,
					"X-Webhook-Event": event,
					"X-Webhook-Id": webhook.id,
					"User-Agent": "Procella-Webhooks/1.0",
				};

				const resp = await fetch(webhook.url, {
					method: "POST",
					headers: requestHeaders,
					body,
					signal: AbortSignal.timeout(10_000),
				});
				const duration = Date.now() - start;
				const responseBody = await resp.text().catch(() => "");
				const responseHeaders = Object.fromEntries(resp.headers.entries());

				await this.recordDelivery({
					webhookId: webhook.id,
					event,
					payload: JSON.parse(body) as Record<string, unknown>,
					requestHeaders,
					responseStatus: resp.status,
					responseBody: responseBody.slice(0, 1024),
					responseHeaders,
					duration,
					attempt,
					success: resp.ok,
					error: null,
				});

				if (resp.ok) {
					return;
				}
			} catch (error: unknown) {
				const duration = Date.now() - start;
				await this.recordDelivery({
					webhookId: webhook.id,
					event,
					payload: JSON.parse(body) as Record<string, unknown>,
					requestHeaders: {
						"Content-Type": "application/json",
						"X-Webhook-Signature": `sha256=${signature}`,
						"X-Webhook-Event": event,
						"X-Webhook-Id": webhook.id,
						"User-Agent": "Procella-Webhooks/1.0",
					},
					responseStatus: null,
					responseBody: null,
					responseHeaders: null,
					duration,
					attempt,
					success: false,
					error: String(error),
				});
			}

			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
			}
		}
	}

	private async dispatchOnce(
		webhook: WebhookRow,
		event: string,
		payload: Record<string, unknown>,
	): Promise<string> {
		validateWebhookUrl(webhook.url);
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
