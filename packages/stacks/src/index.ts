// @strata/stacks — Stack management domain (projects, stacks, tags)

import type { Database } from "@strata/db";
import { projects, stacks } from "@strata/db";
import {
	ConflictError,
	parseStackFQN,
	StackAlreadyExistsError,
	StackNotFoundError,
} from "@strata/types";
import { and, eq, sql } from "drizzle-orm";

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
	createdAt: Date;
	updatedAt: Date;
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

	getStackByFQN(tenantId: string, fqn: string): Promise<StackInfo>;
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
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				};
			});
		} catch (err: unknown) {
			// Drizzle wraps Postgres errors in DrizzleQueryError with cause
			const pgErr = err instanceof Error && err.cause instanceof Error ? err.cause : err;
			if (
				typeof pgErr === "object" &&
				pgErr !== null &&
				"errno" in pgErr &&
				(pgErr as { errno: string }).errno === "23505"
			) {
				throw new StackAlreadyExistsError(tenantId, project, stack);
			}
			throw err;
		}
	}

	async getStack(
		tenantId: string,
		_org: string,
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
			.where(
				and(eq(projects.tenantId, tenantId), eq(projects.name, project), eq(stacks.name, stack)),
			);

		if (rows.length === 0) {
			throw new StackNotFoundError(tenantId, project, stack);
		}

		return toStackInfo(rows[0]);
	}

	async listStacks(tenantId: string, org?: string, project?: string): Promise<StackInfo[]> {
		const conditions = [eq(projects.tenantId, org ?? tenantId)];

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
	}

	async deleteStack(tenantId: string, _org: string, project: string, stack: string): Promise<void> {
		// Find the stack first to verify ownership
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

		await this.db.delete(stacks).where(eq(stacks.id, rows[0].stackId));
	}

	async renameStack(
		tenantId: string,
		_org: string,
		project: string,
		oldStack: string,
		newStack: string,
	): Promise<void> {
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
	}

	async updateStackTags(
		tenantId: string,
		_org: string,
		project: string,
		stack: string,
		tags: Record<string, string>,
	): Promise<void> {
		// Find the stack
		const rows = await this.db
			.select({
				stackId: stacks.id,
				existingTags: stacks.tags,
			})
			.from(stacks)
			.innerJoin(projects, eq(stacks.projectId, projects.id))
			.where(
				and(eq(projects.tenantId, tenantId), eq(projects.name, project), eq(stacks.name, stack)),
			);

		if (rows.length === 0) {
			throw new StackNotFoundError(tenantId, project, stack);
		}

		const existingTags = (rows[0].existingTags ?? {}) as Record<string, string>;
		const merged = mergeTags(existingTags, tags);

		await this.db
			.update(stacks)
			.set({ tags: merged, updatedAt: sql`now()` })
			.where(eq(stacks.id, rows[0].stackId));
	}

	async getStackByFQN(tenantId: string, fqn: string): Promise<StackInfo> {
		const parsed = parseStackFQN(fqn);
		return this.getStack(tenantId, parsed.org, parsed.project, parsed.stack);
	}
}
