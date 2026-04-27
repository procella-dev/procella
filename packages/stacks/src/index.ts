// @procella/stacks — Stack management domain (projects, stacks, tags)

import type { Database } from "@procella/db";
import { projects, stacks } from "@procella/db";
import { withDbSpan, withSpan } from "@procella/telemetry";
import {
	BadRequestError,
	ConflictError,
	InvalidNameError,
	parseStackFQN,
	StackAlreadyExistsError,
	StackNotFoundError,
} from "@procella/types";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const MAX_NAME_LENGTH = 64;
const MIN_NAME_LENGTH = 1;

export function validateName(name: string, kind: "org" | "project" | "stack"): void {
	if (typeof name !== "string") throw new InvalidNameError(`${kind} name must be a string`);
	if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
		throw new InvalidNameError(`${kind} name length must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH}`);
	}
	if (!NAME_REGEX.test(name)) {
		throw new InvalidNameError(`${kind} name must match ${NAME_REGEX.source}`);
	}
}

export function pgErrorCode(err: unknown): string | undefined {
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
// Types
// ============================================================================

export interface StackInfo {
	id: string;
	projectId: string;
	tenantId: string;
	orgName: string;
	projectName: string;
	stackName: string;
	tags: Record<string, string>;
	activeUpdateId: string | null;
	lastUpdate: number | null;
	resourceCount: number | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface SearchStacksParams {
	query?: string;
	organization?: string;
	project?: string;
	tagName?: string;
	tagValue?: string;
	continuationToken?: string;
	pageSize?: number;
	sortBy?: "name" | "lastUpdated" | "created";
	sortOrder?: "asc" | "desc";
}

export interface StackPage {
	stacks: StackInfo[];
	continuationToken?: string;
}

interface StackSearchCursor {
	id: string;
	sortValue: string;
}

// ============================================================================
// Service Interface
// ============================================================================

export interface StacksService {
	createStack(
		tenantId: string,
		org: string,
		project: string,
		stack: string,
		tags?: Record<string, string>,
	): Promise<StackInfo>;

	getStack(tenantId: string, org: string, project: string, stack: string): Promise<StackInfo>;

	listStacks(tenantId: string, org?: string, project?: string): Promise<StackInfo[]>;

	searchStacks?(tenantId: string, params: SearchStacksParams): Promise<StackPage>;

	deleteStack(tenantId: string, org: string, project: string, stack: string): Promise<void>;

	renameStack(
		tenantId: string,
		org: string,
		project: string,
		oldStack: string,
		newStack: string,
	): Promise<void>;

	updateStackTags(
		tenantId: string,
		org: string,
		project: string,
		stack: string,
		tags: Record<string, string>,
	): Promise<void>;

	replaceStackTags(
		tenantId: string,
		org: string,
		project: string,
		stack: string,
		tags: Record<string, string>,
	): Promise<void>;

	getStackByFQN(tenantId: string, fqn: string): Promise<StackInfo>;
	/**
	 * System-only: scoped by tenantId only (passed via the `org` param). The query is
	 * `(projects.tenantId = org AND projects.name = project AND stacks.name = stack)`.
	 * Callers MUST be system-context (auth middleware, GC) — there is no caller-context
	 * authorization, only the URL-tuple resolution.
	 */
	getStackByNames_systemOnly(org: string, project: string, stack: string): Promise<StackInfo>;
}

// ============================================================================
// Pure helpers (exported for testing)
// ============================================================================

/** Build Pulumi standard tags merged with user-provided tags. */
export function buildStackTags(
	projectName: string,
	stackName: string,
	userTags?: Record<string, string>,
): Record<string, string> {
	return {
		"pulumi:project": projectName,
		"pulumi:stack": stackName,
		...userTags,
	};
}

/** Merge new tags into existing tags (new overrides existing). */
export function mergeTags(
	existing: Record<string, string>,
	incoming: Record<string, string>,
): Record<string, string> {
	return { ...existing, ...incoming };
}

export function sanitizeTsQuery(query: string): string | undefined {
	const terms = query
		.trim()
		.split(/\s+/)
		.map((part) => part.replace(/[^a-zA-Z0-9_]/g, ""))
		.filter((part) => part.length > 0);

	if (terms.length === 0) {
		return undefined;
	}

	// Append :* for prefix matching so "g" matches "gamma", "comp" matches "component"
	return terms.map((t) => `${t}:*`).join(" & ");
}

export function encodeContinuationToken(cursor: StackSearchCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

export function decodeContinuationToken(token: string): StackSearchCursor {
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
	} catch {
		throw new BadRequestError("Invalid continuation token");
	}

	if (
		typeof decoded !== "object" ||
		decoded === null ||
		typeof (decoded as Record<string, unknown>).id !== "string" ||
		typeof (decoded as Record<string, unknown>).sortValue !== "string"
	) {
		throw new BadRequestError("Invalid continuation token");
	}

	return {
		id: (decoded as Record<string, unknown>).id as string,
		sortValue: (decoded as Record<string, unknown>).sortValue as string,
	};
}

// ============================================================================
// Row → StackInfo mapper
// ============================================================================

function toStackInfo(row: {
	stack_id: string;
	stack_name: string;
	stack_tags: unknown;
	stack_active_update_id: string | null;
	stack_created_at: Date;
	stack_updated_at: Date;
	project_id: string;
	project_tenant_id: string;
	project_name: string;
}): StackInfo {
	return {
		id: row.stack_id,
		projectId: row.project_id,
		tenantId: row.project_tenant_id,
		orgName: row.project_tenant_id,
		projectName: row.project_name,
		stackName: row.stack_name,
		tags: (row.stack_tags ?? {}) as Record<string, string>,
		activeUpdateId: row.stack_active_update_id,
		lastUpdate: Math.floor(row.stack_updated_at.getTime() / 1000),
		resourceCount: null,
		createdAt: row.stack_created_at,
		updatedAt: row.stack_updated_at,
	};
}

// ============================================================================
// PostgresStacksService
// ============================================================================

export class PostgresStacksService implements StacksService {
	private readonly db: Database;

	constructor({ db }: { db: Database }) {
		this.db = db;
	}

	async createStack(
		tenantId: string,
		_org: string,
		project: string,
		stack: string,
		userTags?: Record<string, string>,
	): Promise<StackInfo> {
		validateName(_org, "org");
		validateName(project, "project");
		validateName(stack, "stack");

		return withDbSpan(
			"createStack",
			{
				"tenant.id": tenantId,
				"org.name": _org,
				"project.name": project,
				"stack.name": stack,
			},
			async () => {
				const tags = buildStackTags(project, stack, userTags);

				try {
					return await this.db.transaction(async (tx) => {
						// Auto-create project (INSERT ON CONFLICT DO NOTHING)
						await tx
							.insert(projects)
							.values({ tenantId, name: project })
							.onConflictDoNothing({
								target: [projects.tenantId, projects.name],
							});

						// Fetch the project (may have existed already)
						const [proj] = await tx
							.select({ id: projects.id })
							.from(projects)
							.where(and(eq(projects.tenantId, tenantId), eq(projects.name, project)));

						// Insert the stack
						const [row] = await tx
							.insert(stacks)
							.values({ projectId: proj.id, name: stack, tags })
							.returning();

						return {
							id: row.id,
							projectId: proj.id,
							tenantId,
							orgName: tenantId,
							projectName: project,
							stackName: stack,
							tags: (row.tags ?? {}) as Record<string, string>,
							activeUpdateId: row.activeUpdateId,
							lastUpdate: null,
							resourceCount: null,
							createdAt: row.createdAt,
							updatedAt: row.updatedAt,
						};
					});
				} catch (err: unknown) {
					if (pgErrorCode(err) === "23505") {
						throw new StackAlreadyExistsError(tenantId, project, stack);
					}
					throw err;
				}
			},
		);
	}

	async getStack(
		tenantId: string,
		_org: string,
		project: string,
		stack: string,
	): Promise<StackInfo> {
		return withDbSpan(
			"getStack",
			{
				"tenant.id": tenantId,
				"org.name": _org,
				"project.name": project,
				"stack.name": stack,
			},
			async () => {
				const rows = await this.db
					.select({
						stack_id: stacks.id,
						stack_name: stacks.name,
						stack_tags: stacks.tags,
						stack_active_update_id: stacks.activeUpdateId,
						stack_created_at: stacks.createdAt,
						stack_updated_at: stacks.updatedAt,
						project_id: projects.id,
						project_tenant_id: projects.tenantId,
						project_name: projects.name,
					})
					.from(stacks)
					.innerJoin(projects, eq(stacks.projectId, projects.id))
					.where(
						and(
							eq(projects.tenantId, tenantId),
							eq(projects.name, project),
							eq(stacks.name, stack),
						),
					);

				if (rows.length === 0) {
					throw new StackNotFoundError(tenantId, project, stack);
				}

				return toStackInfo(rows[0]);
			},
		);
	}

	async listStacks(tenantId: string, _org?: string, project?: string): Promise<StackInfo[]> {
		return withDbSpan(
			"listStacks",
			{ "tenant.id": tenantId, "org.name": _org ?? "", "project.name": project ?? "" },
			async () => {
				const conditions = [eq(projects.tenantId, tenantId)];

				if (project) {
					conditions.push(eq(projects.name, project));
				}

				const rows = await this.db
					.select({
						stack_id: stacks.id,
						stack_name: stacks.name,
						stack_tags: stacks.tags,
						stack_active_update_id: stacks.activeUpdateId,
						stack_created_at: stacks.createdAt,
						stack_updated_at: stacks.updatedAt,
						project_id: projects.id,
						project_tenant_id: projects.tenantId,
						project_name: projects.name,
					})
					.from(stacks)
					.innerJoin(projects, eq(stacks.projectId, projects.id))
					.where(and(...conditions));

				return rows.map(toStackInfo);
			},
		);
	}

	async searchStacks(tenantId: string, params: SearchStacksParams): Promise<StackPage> {
		const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
		const sortBy = params.sortBy ?? "name";
		const sortOrder = params.sortOrder ?? "asc";
		const conditions: SQL[] = [eq(projects.tenantId, tenantId)];

		if (params.project) {
			conditions.push(eq(projects.name, params.project));
		}

		if (params.tagName && params.tagValue !== undefined) {
			conditions.push(sql`${stacks.tags} ->> ${params.tagName} = ${params.tagValue}`);
		} else if (params.tagName) {
			conditions.push(sql`${stacks.tags} ? ${params.tagName}`);
		}

		if (params.query) {
			const tsQuery = sanitizeTsQuery(params.query);
			if (tsQuery) {
				conditions.push(sql`${stacks.searchVector}::tsvector @@ to_tsquery('simple', ${tsQuery})`);
			}
		}

		const sortColumn =
			sortBy === "name"
				? stacks.name
				: sortBy === "lastUpdated"
					? stacks.updatedAt
					: stacks.createdAt;

		if (params.continuationToken) {
			const cursor = decodeContinuationToken(params.continuationToken);

			if (sortBy === "name") {
				conditions.push(
					sortOrder === "asc"
						? sql`(${sortColumn} > ${cursor.sortValue} OR (${sortColumn} = ${cursor.sortValue} AND ${stacks.id} > ${cursor.id}))`
						: sql`(${sortColumn} < ${cursor.sortValue} OR (${sortColumn} = ${cursor.sortValue} AND ${stacks.id} < ${cursor.id}))`,
				);
			} else {
				const sortDate = new Date(cursor.sortValue);
				if (Number.isNaN(sortDate.getTime())) {
					throw new BadRequestError("Invalid continuation token");
				}
				conditions.push(
					sortOrder === "asc"
						? sql`(${sortColumn} > ${sortDate} OR (${sortColumn} = ${sortDate} AND ${stacks.id} > ${cursor.id}))`
						: sql`(${sortColumn} < ${sortDate} OR (${sortColumn} = ${sortDate} AND ${stacks.id} < ${cursor.id}))`,
				);
			}
		}

		const rows = await this.db
			.select({
				stack_id: stacks.id,
				stack_name: stacks.name,
				stack_tags: stacks.tags,
				stack_active_update_id: stacks.activeUpdateId,
				stack_created_at: stacks.createdAt,
				stack_updated_at: stacks.updatedAt,
				project_id: projects.id,
				project_tenant_id: projects.tenantId,
				project_name: projects.name,
			})
			.from(stacks)
			.innerJoin(projects, eq(stacks.projectId, projects.id))
			.where(and(...conditions))
			.orderBy(
				sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn),
				sortOrder === "asc" ? asc(stacks.id) : desc(stacks.id),
			)
			.limit(pageSize + 1);

		const hasMore = rows.length > pageSize;
		const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
		const stackInfos = pageRows.map(toStackInfo);

		if (!hasMore || pageRows.length === 0) {
			return { stacks: stackInfos };
		}

		const lastRow = pageRows[pageRows.length - 1];
		const sortValue =
			sortBy === "name"
				? lastRow.stack_name
				: sortBy === "lastUpdated"
					? lastRow.stack_updated_at.toISOString()
					: lastRow.stack_created_at.toISOString();

		return {
			stacks: stackInfos,
			continuationToken: encodeContinuationToken({ id: lastRow.stack_id, sortValue }),
		};
	}

	async deleteStack(tenantId: string, _org: string, project: string, stack: string): Promise<void> {
		return withDbSpan(
			"deleteStack",
			{
				"tenant.id": tenantId,
				"org.name": _org,
				"project.name": project,
				"stack.name": stack,
			},
			async () => {
				// Find the stack first to verify ownership
				const rows = await this.db
					.select({ stackId: stacks.id })
					.from(stacks)
					.innerJoin(projects, eq(stacks.projectId, projects.id))
					.where(
						and(
							eq(projects.tenantId, tenantId),
							eq(projects.name, project),
							eq(stacks.name, stack),
						),
					);

				if (rows.length === 0) {
					throw new StackNotFoundError(tenantId, project, stack);
				}

				await this.db.delete(stacks).where(eq(stacks.id, rows[0].stackId));
			},
		);
	}

	async renameStack(
		tenantId: string,
		_org: string,
		project: string,
		oldStack: string,
		newStack: string,
	): Promise<void> {
		validateName(newStack, "stack");

		return withDbSpan(
			"renameStack",
			{
				"tenant.id": tenantId,
				"org.name": _org,
				"project.name": project,
				"stack.old_name": oldStack,
				"stack.new_name": newStack,
			},
			async () => {
				if (oldStack === newStack) {
					throw new ConflictError(`Cannot rename stack to the same name: ${oldStack}`);
				}

				await this.db.transaction(async (tx) => {
					// Find the stack
					const rows = await tx
						.select({ stackId: stacks.id, projectId: projects.id })
						.from(stacks)
						.innerJoin(projects, eq(stacks.projectId, projects.id))
						.where(
							and(
								eq(projects.tenantId, tenantId),
								eq(projects.name, project),
								eq(stacks.name, oldStack),
							),
						);

					if (rows.length === 0) {
						throw new StackNotFoundError(tenantId, project, oldStack);
					}

					// Check if new name already exists in the same project
					const existing = await tx
						.select({ id: stacks.id })
						.from(stacks)
						.where(and(eq(stacks.projectId, rows[0].projectId), eq(stacks.name, newStack)));

					if (existing.length > 0) {
						throw new StackAlreadyExistsError(tenantId, project, newStack);
					}

					// Rename
					await tx
						.update(stacks)
						.set({ name: newStack, updatedAt: sql`now()` })
						.where(eq(stacks.id, rows[0].stackId));
				});
			},
		);
	}

	async updateStackTags(
		tenantId: string,
		_org: string,
		project: string,
		stack: string,
		tags: Record<string, string>,
	): Promise<void> {
		return withDbSpan(
			"updateStackTags",
			{
				"tenant.id": tenantId,
				"org.name": _org,
				"project.name": project,
				"stack.name": stack,
				"tags.count": Object.keys(tags).length,
			},
			() =>
				this.db.transaction(async (tx) => {
					const rows = await tx
						.select({ stackId: stacks.id, stackTags: stacks.tags })
						.from(stacks)
						.innerJoin(projects, eq(stacks.projectId, projects.id))
						.where(
							and(
								eq(projects.tenantId, tenantId),
								eq(projects.name, project),
								eq(stacks.name, stack),
							),
						);

					if (rows.length === 0) {
						throw new StackNotFoundError(tenantId, project, stack);
					}

					await tx
						.update(stacks)
						.set({
							tags: mergeTags((rows[0].stackTags ?? {}) as Record<string, string>, tags),
							updatedAt: sql`now()`,
						})
						.where(eq(stacks.id, rows[0].stackId));
				}),
		);
	}

	async replaceStackTags(
		tenantId: string,
		_org: string,
		project: string,
		stack: string,
		tags: Record<string, string>,
	): Promise<void> {
		const rows = await this.db
			.select({ stackId: stacks.id })
			.from(stacks)
			.innerJoin(projects, eq(stacks.projectId, projects.id))
			.where(
				and(eq(projects.tenantId, tenantId), eq(projects.name, project), eq(stacks.name, stack)),
			);

		if (rows.length === 0) {
			throw new StackNotFoundError(tenantId, project, stack);
		}

		await this.db
			.update(stacks)
			.set({ tags, updatedAt: sql`now()` })
			.where(eq(stacks.id, rows[0].stackId));
	}

	async getStackByFQN(tenantId: string, fqn: string): Promise<StackInfo> {
		return withSpan(
			"procella.stacks",
			"getStackByFQN",
			{ "tenant.id": tenantId, "stack.fqn": fqn },
			async () => {
				const parsed = parseStackFQN(fqn);
				return this.getStack(tenantId, parsed.org, parsed.project, parsed.stack);
			},
		);
	}

	async getStackByNames_systemOnly(
		org: string,
		project: string,
		stack: string,
	): Promise<StackInfo> {
		const rows = await this.db
			.select({
				stack_id: stacks.id,
				stack_name: stacks.name,
				stack_tags: stacks.tags,
				stack_active_update_id: stacks.activeUpdateId,
				stack_created_at: stacks.createdAt,
				stack_updated_at: stacks.updatedAt,
				project_id: projects.id,
				project_tenant_id: projects.tenantId,
				project_name: projects.name,
			})
			.from(stacks)
			.innerJoin(projects, eq(stacks.projectId, projects.id))
			.where(and(eq(projects.tenantId, org), eq(projects.name, project), eq(stacks.name, stack)));

		if (rows.length === 0) {
			throw new StackNotFoundError(org, project, stack);
		}
		return toStackInfo(rows[0]);
	}
}
