// @procella/db — Drizzle ORM schema definitions for Strata's PostgreSQL database.
//
// This is a multi-tenant SaaS. Auth is Descope (no users/orgs tables).
// tenant_id is TEXT from Descope JWT — never a FK, always a soft reference.
// Cross-domain references (stack_id in updates) are soft references (no FK).

import { sql } from "drizzle-orm";
import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// ============================================================================
// projects — Tenant-scoped project registry
// ============================================================================

export const projects = pgTable(
	"projects",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		name: text().notNull(),
		description: text(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_projects_tenant_name").on(table.tenantId, table.name)],
);

// ============================================================================
// stacks — Stack registry within projects
// ============================================================================

export const stacks = pgTable(
	"stacks",
	{
		id: uuid().primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text().notNull(),
		tags: jsonb().notNull().default({}),
		activeUpdateId: uuid("active_update_id"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_stacks_project_name").on(table.projectId, table.name)],
);

// ============================================================================
// updates — Update lifecycle tracking
// ============================================================================

export const updates = pgTable(
	"updates",
	{
		id: uuid().primaryKey().defaultRandom(),
		stackId: uuid("stack_id").notNull(),
		kind: text().notNull(),
		status: text().notNull().default("not started"),
		result: text(),
		message: text(),
		version: integer().notNull().default(1),
		leaseToken: text("lease_token"),
		leaseExpiresAt: timestamp("lease_expires_at"),
		startedAt: timestamp("started_at"),
		completedAt: timestamp("completed_at"),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
		config: jsonb(),
		program: jsonb(),
	},
	(table) => [
		uniqueIndex("idx_updates_active")
			.on(table.stackId)
			.where(sql`status IN ('not started', 'requested', 'running')`),
	],
);

// ============================================================================
// checkpoints — State snapshots
// ============================================================================

export const checkpoints = pgTable(
	"checkpoints",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		stackId: uuid("stack_id").notNull(),
		version: integer().notNull(),
		data: jsonb(),
		blobKey: text("blob_key"),
		isDelta: boolean("is_delta").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_checkpoints_update_version").on(table.updateId, table.version)],
);

// ============================================================================
// update_events — Engine events during updates
// ============================================================================

export const updateEvents = pgTable(
	"update_events",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		sequence: integer().notNull(),
		kind: text().notNull(),
		fields: jsonb().notNull().default({}),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_update_events_update_sequence").on(table.updateId, table.sequence)],
);

// ============================================================================
// Schema export — pass to drizzle() for relational queries
// ============================================================================

export const schema = {
	projects,
	stacks,
	updates,
	checkpoints,
	updateEvents,
};
