import type DescopeSdk from "@descope/node-sdk";

type DescopeClient = ReturnType<typeof DescopeSdk>;

type DescopeAuditRecord = {
	id?: string;
	action?: string;
	type?: string;
	actorId?: string;
	tenantId?: string;
	userId?: string;
	createdTime?: string | number;
	createdAt?: string | number;
	data?: Record<string, unknown>;
};

type DescopeAuditSearchResponse = {
	data?: DescopeAuditRecord[];
};

export const AuditAction = {
	STACK_CREATE: "stack.create",
	STACK_DELETE: "stack.delete",
	STACK_UPDATE: "stack.update",
	STACK_RENAME: "stack.rename",
	STACK_EXPORT: "stack.export",
	STACK_IMPORT: "stack.import",
	STACK_TAGS_UPDATE: "stack.tags.update",
	UPDATE_CREATE: "update.create",
	UPDATE_CANCEL: "update.cancel",
	UPDATE_COMPLETE: "update.complete",
	TOKEN_CREATE: "token.create",
	TOKEN_REVOKE: "token.revoke",
	WEBHOOK_CREATE: "webhook.create",
	WEBHOOK_DELETE: "webhook.delete",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditLogEntry {
	id: string;
	actorId: string;
	actorType: "user" | "token" | "workload";
	action: AuditActionValue;
	resourceType: string;
	resourceId: string;
	ipAddress?: string;
	userAgent?: string;
	metadata?: Record<string, unknown>;
	createdAt: Date;
}

export interface AuditLogParams {
	startTime?: Date;
	endTime?: Date;
	action?: string;
	page?: number;
	pageSize?: number;
}

export interface AuditService {
	log(tenantId: string, entry: Omit<AuditLogEntry, "id" | "createdAt">): void;
	query(
		tenantId: string,
		params: AuditLogParams,
	): Promise<{ entries: AuditLogEntry[]; total: number }>;
	export(
		tenantId: string,
		params: Omit<AuditLogParams, "page" | "pageSize">,
	): Promise<AuditLogEntry[]>;
}

export function mapRouteToAction(method: string, path: string): AuditActionValue | null {
	if (method === "POST" && /^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+$/.test(path)) {
		return AuditAction.STACK_CREATE;
	}
	if (method === "DELETE" && /^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+$/.test(path)) {
		return AuditAction.STACK_DELETE;
	}
	if (method === "POST" && /^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/rename$/.test(path)) {
		return AuditAction.STACK_RENAME;
	}
	if (method === "PATCH" && /^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/tags$/.test(path)) {
		return AuditAction.STACK_TAGS_UPDATE;
	}
	if (
		method === "POST" &&
		/^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/(?:update|preview|refresh|destroy)$/.test(path)
	) {
		return AuditAction.UPDATE_CREATE;
	}
	if (
		method === "POST" &&
		/^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/update\/[^/]+\/complete$/.test(path)
	) {
		return AuditAction.UPDATE_COMPLETE;
	}
	if (
		method === "POST" &&
		/^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/update\/[^/]+\/cancel$/.test(path)
	) {
		return AuditAction.UPDATE_CANCEL;
	}
	if (method === "POST" && /^\/api\/stacks\/[^/]+\/[^/]+\/[^/]+\/import$/.test(path)) {
		return AuditAction.STACK_IMPORT;
	}
	if (method === "POST" && /^\/api\/orgs\/[^/]+\/tokens$/.test(path)) {
		return AuditAction.TOKEN_CREATE;
	}
	if (method === "DELETE" && /^\/api\/orgs\/[^/]+\/tokens\/[^/]+$/.test(path)) {
		return AuditAction.TOKEN_REVOKE;
	}
	if (method === "POST" && /^\/api\/orgs\/[^/]+\/hooks$/.test(path)) {
		return AuditAction.WEBHOOK_CREATE;
	}
	if (method === "DELETE" && /^\/api\/orgs\/[^/]+\/hooks\/[^/]+$/.test(path)) {
		return AuditAction.WEBHOOK_DELETE;
	}

	return null;
}

export function extractResourceType(path: string): string {
	if (path.startsWith("/api/stacks/")) {
		if (path.includes("/update/")) {
			return "update";
		}
		return "stack";
	}
	if (path.includes("/tokens")) {
		return "token";
	}
	if (path.includes("/hooks")) {
		return "webhook";
	}
	return "unknown";
}

export function extractResourceId(path: string): string {
	const stackMatch = path.match(/^\/api\/stacks\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
	if (stackMatch) {
		const org = stackMatch[1];
		const project = stackMatch[2];
		const stack = stackMatch[3];
		return stack ? `${org}/${project}/${stack}` : `${org}/${project}`;
	}

	const tokenMatch = path.match(/^\/api\/orgs\/([^/]+)\/tokens(?:\/([^/]+))?/);
	if (tokenMatch) {
		const org = tokenMatch[1];
		const tokenId = tokenMatch[2];
		return tokenId ? `${org}/${tokenId}` : org;
	}

	return path;
}

export function mapActionToType(action: string): "info" | "warn" | "error" {
	if (action.includes("delete") || action.includes("revoke") || action.includes("cancel")) {
		return "warn";
	}
	return "info";
}

function toEpochSeconds(date: Date | undefined): number | undefined {
	if (!date) {
		return undefined;
	}
	return Math.floor(date.getTime() / 1000);
}

function inferActorType(
	actorId: string,
	metadata: Record<string, unknown>,
): AuditLogEntry["actorType"] {
	if (metadata.workload && typeof metadata.workload === "object") {
		return "workload";
	}
	return actorId.startsWith("token:") ? "token" : "user";
}

function mapDescopeRecordToEntry(record: DescopeAuditRecord): AuditLogEntry {
	const data = record.data ?? {};
	const { resourceType, resourceId, ipAddress, userAgent, ...metadata } = data as Record<
		string,
		unknown
	>;

	const ts = record.createdTime ?? record.createdAt ?? Date.now();
	const createdAt =
		typeof ts === "number" ? new Date(ts > 1_000_000_000_000 ? ts : ts * 1000) : new Date(ts);

	const actorId = record.actorId ?? record.userId ?? "unknown";

	return {
		id: record.id ?? `${record.action ?? "audit"}-${createdAt.getTime()}`,
		actorId,
		actorType: inferActorType(actorId, metadata),
		action: (record.action ?? AuditAction.STACK_UPDATE) as AuditActionValue,
		resourceType: typeof resourceType === "string" ? resourceType : "unknown",
		resourceId: typeof resourceId === "string" ? resourceId : "unknown",
		ipAddress: typeof ipAddress === "string" ? ipAddress : undefined,
		userAgent: typeof userAgent === "string" ? userAgent : undefined,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		createdAt,
	};
}

export class DescopeAuditService implements AuditService {
	constructor(private readonly sdk: DescopeClient) {}

	log(tenantId: string, entry: Omit<AuditLogEntry, "id" | "createdAt">): void {
		void this.createEvent(tenantId, entry).catch((error: unknown) => {
			console.error("[audit] Failed to push event to Descope:", error);
		});
	}

	private async createEvent(
		tenantId: string,
		entry: Omit<AuditLogEntry, "id" | "createdAt">,
	): Promise<void> {
		await this.sdk.management.audit.createEvent({
			action: entry.action,
			type: mapActionToType(entry.action),
			actorId: entry.actorId,
			tenantId,
			userId: entry.actorType === "user" ? entry.actorId : undefined,
			data: {
				resourceType: entry.resourceType,
				resourceId: entry.resourceId,
				ipAddress: entry.ipAddress,
				userAgent: entry.userAgent,
				...entry.metadata,
			},
		});
	}

	async query(
		tenantId: string,
		params: AuditLogParams,
	): Promise<{ entries: AuditLogEntry[]; total: number }> {
		const page = Math.max((params.page ?? 1) - 1, 0);
		const size = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
		const response = (await this.sdk.management.audit.search({
			tenants: [tenantId],
			actions: params.action ? [params.action] : undefined,
			from: toEpochSeconds(params.startTime),
			to: toEpochSeconds(params.endTime),
		})) as DescopeAuditSearchResponse;

		const allEntries = (response.data ?? []).map(mapDescopeRecordToEntry);
		const start = page * size;
		const entries = allEntries.slice(start, start + size);
		return { entries, total: allEntries.length };
	}

	async export(
		tenantId: string,
		params: Omit<AuditLogParams, "page" | "pageSize">,
	): Promise<AuditLogEntry[]> {
		const response = (await this.sdk.management.audit.search({
			tenants: [tenantId],
			actions: params.action ? [params.action] : undefined,
			from: toEpochSeconds(params.startTime),
			to: toEpochSeconds(params.endTime),
		})) as DescopeAuditSearchResponse;

		return (response.data ?? []).map(mapDescopeRecordToEntry);
	}
}

export class NoopAuditService implements AuditService {
	log(): void {}

	async query(): Promise<{ entries: AuditLogEntry[]; total: number }> {
		return { entries: [], total: 0 };
	}

	async export(): Promise<AuditLogEntry[]> {
		return [];
	}
}
