// @procella/db — Drizzle ORM schema definitions for Procella's PostgreSQL database.
//
// This is a multi-tenant SaaS. Auth is Descope (no users/orgs tables).
// tenant_id is TEXT from Descope JWT — never a FK, always a soft reference.
// Cross-domain references (stack_id in updates) are soft references (no FK).

import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
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
		searchVector: text("search_vector"),
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
// journal_entries — Per-resource journal entries for journaling protocol
// ============================================================================

export const journalEntries = pgTable(
	"journal_entries",
	{
		id: uuid().primaryKey().defaultRandom(),
		updateId: uuid("update_id")
			.notNull()
			.references(() => updates.id, { onDelete: "cascade" }),
		stackId: uuid("stack_id").notNull(),
		sequenceId: bigint("sequence_id", { mode: "bigint" }).notNull(),
		operationId: bigint("operation_id", { mode: "bigint" }).notNull(),
		kind: integer().notNull(),
		state: jsonb(),
		operation: jsonb(),
		secretsProvider: jsonb("secrets_provider"),
		newSnapshot: jsonb("new_snapshot"),
		operationType: text("operation_type"),
		removeOld: bigint("remove_old", { mode: "bigint" }),
		removeNew: bigint("remove_new", { mode: "bigint" }),
		elideWrite: boolean("elide_write").notNull().default(false),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [uniqueIndex("idx_journal_entries_update_seq").on(table.updateId, table.sequenceId)],
);

export const webhooks = pgTable(
	"webhooks",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		name: text().notNull(),
		url: text().notNull(),
		secret: text().notNull(),
		events: text().array().notNull(),
		active: boolean().notNull().default(true),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [index("idx_webhooks_tenant").on(table.tenantId)],
);

export const webhookDeliveries = pgTable(
	"webhook_deliveries",
	{
		id: uuid().primaryKey().defaultRandom(),
		webhookId: uuid("webhook_id")
			.notNull()
			.references(() => webhooks.id, { onDelete: "cascade" }),
		event: text().notNull(),
		payload: jsonb().notNull(),
		requestHeaders: jsonb("request_headers"),
		responseStatus: integer("response_status"),
		responseBody: text("response_body"),
		responseHeaders: jsonb("response_headers"),
		duration: integer(),
		attempt: integer().notNull().default(1),
		success: boolean().notNull().default(false),
		error: text(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_deliveries_webhook").on(table.webhookId),
		index("idx_deliveries_created").on(table.createdAt.desc()),
	],
);

export const githubInstallations = pgTable(
	"github_installations",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		installationId: integer("installation_id").notNull(),
		accountLogin: text("account_login").notNull(),
		accountType: text("account_type").notNull(),
		repositorySelection: text("repository_selection").notNull(),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_github_tenant").on(table.tenantId),
		uniqueIndex("idx_github_tenant_installation").on(table.tenantId, table.installationId),
	],
);

export const oidcTrustPolicies = pgTable(
	"oidc_trust_policies",
	{
		id: uuid().primaryKey().defaultRandom(),
		tenantId: text("tenant_id").notNull(),
		orgSlug: text("org_slug").notNull(),
		provider: text().notNull(),
		displayName: text("display_name").notNull(),
		issuer: text().notNull(),
		maxExpiration: integer("max_expiration").notNull().default(7200),
		claimConditions: jsonb("claim_conditions").notNull().$type<Record<string, string>>(),
		grantedRole: text("granted_role").notNull(),
		active: boolean().notNull().default(true),
		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("idx_oidc_trust_tenant").on(table.tenantId),
		uniqueIndex("idx_oidc_trust_org_name").on(table.orgSlug, table.displayName),
		index("idx_oidc_trust_org_slug").on(table.orgSlug),
	],
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
	journalEntries,
	webhooks,
	webhookDeliveries,
	githubInstallations,
	oidcTrustPolicies,
};
