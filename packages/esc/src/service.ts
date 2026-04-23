import {
	type Database,
	escEnvironmentRevisions,
	escEnvironments,
	escProjects,
	escSessions,
} from "@procella/db";
import { BadRequestError, ConflictError, NotFoundError } from "@procella/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { EvaluatorClient } from "./evaluator-client.js";
import type {
	CreateEnvironmentInput,
	EscEnvironment,
	EscEnvironmentRevision,
	EscProject,
	OpenSessionResult,
	UpdateEnvironmentInput,
} from "./types.js";

export interface EscService {
	listProjects(tenantId: string): Promise<EscProject[]>;

	createEnvironment(
		tenantId: string,
		input: CreateEnvironmentInput,
		createdBy: string,
	): Promise<EscEnvironment>;
	listEnvironments(tenantId: string, projectName: string): Promise<EscEnvironment[]>;
	getEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironment | null>;
	updateEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
		input: UpdateEnvironmentInput,
		updatedBy: string,
	): Promise<EscEnvironment>;
	deleteEnvironment(tenantId: string, projectName: string, envName: string): Promise<void>;

	listRevisions(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironmentRevision[]>;
	getRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		revisionNumber: number,
	): Promise<EscEnvironmentRevision | null>;

	openSession(tenantId: string, projectName: string, envName: string): Promise<OpenSessionResult>;
	getSession(
		tenantId: string,
		projectName: string,
		envName: string,
		sessionId: string,
	): Promise<OpenSessionResult | null>;
}

export interface PostgresEscServiceDeps {
	db: Database;
	evaluator: EvaluatorClient;
	encryptionKeyHex: string;
	sessionTtlSeconds?: number;
}

function pgErrorCode(err: unknown): string | undefined {
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

function validateName(kind: "project" | "environment", value: string): void {
	if (!value || value.length > 128) {
		throw new BadRequestError(`${kind} name must be 1-128 characters`);
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
		throw new BadRequestError(`${kind} name may only contain letters, digits, '.', '_', '-'`);
	}
}

type EscEnvRow = typeof escEnvironments.$inferSelect;
type EscProjectRow = typeof escProjects.$inferSelect;
type EscRevisionRow = typeof escEnvironmentRevisions.$inferSelect;
type TxOrDb = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

function toEnvInfo(row: EscEnvRow): EscEnvironment {
	return {
		id: row.id,
		projectId: row.projectId,
		name: row.name,
		yamlBody: row.yamlBody,
		currentRevisionNumber: row.currentRevisionNumber,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toProjectInfo(row: EscProjectRow): EscProject {
	return {
		id: row.id,
		tenantId: row.tenantId,
		name: row.name,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toRevisionInfo(row: EscRevisionRow): EscEnvironmentRevision {
	return {
		id: row.id,
		environmentId: row.environmentId,
		revisionNumber: row.revisionNumber,
		yamlBody: row.yamlBody,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
	};
}

async function findEnvRow(
	db: TxOrDb,
	tenantId: string,
	projectName: string,
	envName: string,
): Promise<EscEnvRow | null> {
	const [row] = await db
		.select({ env: escEnvironments })
		.from(escEnvironments)
		.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
		.where(
			and(
				eq(escProjects.tenantId, tenantId),
				eq(escProjects.name, projectName),
				eq(escEnvironments.name, envName),
				isNull(escEnvironments.deletedAt),
			),
		)
		.limit(1);
	return row?.env ?? null;
}

export class PostgresEscService implements EscService {
	private readonly db: Database;
	private readonly evaluator: EvaluatorClient;
	private readonly encryptionKeyHex: string;
	private readonly sessionTtlSeconds: number;

	constructor(deps: PostgresEscServiceDeps) {
		this.db = deps.db;
		this.evaluator = deps.evaluator;
		this.encryptionKeyHex = deps.encryptionKeyHex;
		this.sessionTtlSeconds = deps.sessionTtlSeconds ?? 3600;
	}

	async listProjects(tenantId: string): Promise<EscProject[]> {
		const rows = await this.db
			.select()
			.from(escProjects)
			.where(eq(escProjects.tenantId, tenantId))
			.orderBy(escProjects.name);
		return rows.map(toProjectInfo);
	}

	async createEnvironment(
		tenantId: string,
		input: CreateEnvironmentInput,
		createdBy: string,
	): Promise<EscEnvironment> {
		validateName("project", input.projectName);
		validateName("environment", input.name);
		if (typeof input.yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}

		try {
			return await this.db.transaction(async (tx) => {
				await tx
					.insert(escProjects)
					.values({ tenantId, name: input.projectName })
					.onConflictDoNothing({
						target: [escProjects.tenantId, escProjects.name],
					});

				const [proj] = await tx
					.select({ id: escProjects.id })
					.from(escProjects)
					.where(and(eq(escProjects.tenantId, tenantId), eq(escProjects.name, input.projectName)));

				if (!proj) {
					throw new Error("esc_projects row disappeared after upsert");
				}

				const [env] = await tx
					.insert(escEnvironments)
					.values({
						projectId: proj.id,
						name: input.name,
						yamlBody: input.yamlBody,
						currentRevisionNumber: 1,
						createdBy,
					})
					.returning();

				await tx.insert(escEnvironmentRevisions).values({
					environmentId: env.id,
					revisionNumber: 1,
					yamlBody: input.yamlBody,
					createdBy,
				});

				return toEnvInfo(env);
			});
		} catch (err: unknown) {
			if (pgErrorCode(err) === "23505") {
				throw new ConflictError(`Environment ${input.projectName}/${input.name} already exists`);
			}
			throw err;
		}
	}

	async listEnvironments(tenantId: string, projectName: string): Promise<EscEnvironment[]> {
		validateName("project", projectName);
		const rows = await this.db
			.select({ env: escEnvironments })
			.from(escEnvironments)
			.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
			.where(
				and(
					eq(escProjects.tenantId, tenantId),
					eq(escProjects.name, projectName),
					isNull(escEnvironments.deletedAt),
				),
			)
			.orderBy(escEnvironments.name);
		return rows.map((r) => toEnvInfo(r.env));
	}

	async getEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironment | null> {
		const row = await findEnvRow(this.db, tenantId, projectName, envName);
		return row ? toEnvInfo(row) : null;
	}

	async updateEnvironment(
		tenantId: string,
		projectName: string,
		envName: string,
		input: UpdateEnvironmentInput,
		updatedBy: string,
	): Promise<EscEnvironment> {
		if (typeof input.yamlBody !== "string") {
			throw new BadRequestError("yamlBody must be a string");
		}

		return await this.db.transaction(async (tx) => {
			const [locked] = await tx
				.select({ env: escEnvironments })
				.from(escEnvironments)
				.innerJoin(escProjects, eq(escEnvironments.projectId, escProjects.id))
				.where(
					and(
						eq(escProjects.tenantId, tenantId),
						eq(escProjects.name, projectName),
						eq(escEnvironments.name, envName),
						isNull(escEnvironments.deletedAt),
					),
				)
				.limit(1)
				.for("update");

			if (!locked) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			const row = locked.env;

			const nextRevision = row.currentRevisionNumber + 1;
			const now = new Date();

			const [updated] = await tx
				.update(escEnvironments)
				.set({
					yamlBody: input.yamlBody,
					currentRevisionNumber: nextRevision,
					updatedAt: now,
				})
				.where(eq(escEnvironments.id, row.id))
				.returning();

			await tx.insert(escEnvironmentRevisions).values({
				environmentId: row.id,
				revisionNumber: nextRevision,
				yamlBody: input.yamlBody,
				createdBy: updatedBy,
			});

			return toEnvInfo(updated);
		});
	}

	async deleteEnvironment(tenantId: string, projectName: string, envName: string): Promise<void> {
		await this.db.transaction(async (tx) => {
			const row = await findEnvRow(tx, tenantId, projectName, envName);
			if (!row) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			const result = await tx
				.update(escEnvironments)
				.set({ deletedAt: new Date() })
				.where(and(eq(escEnvironments.id, row.id), isNull(escEnvironments.deletedAt)));
			if (result.rowCount === 0) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
		});
	}

	async listRevisions(
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<EscEnvironmentRevision[]> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			throw new NotFoundError("Environment", `${projectName}/${envName}`);
		}
		const rows = await this.db
			.select()
			.from(escEnvironmentRevisions)
			.where(eq(escEnvironmentRevisions.environmentId, env.id))
			.orderBy(desc(escEnvironmentRevisions.revisionNumber));
		return rows.map(toRevisionInfo);
	}

	async getRevision(
		tenantId: string,
		projectName: string,
		envName: string,
		revisionNumber: number,
	): Promise<EscEnvironmentRevision | null> {
		const env = await findEnvRow(this.db, tenantId, projectName, envName);
		if (!env) {
			return null;
		}
		const [row] = await this.db
			.select()
			.from(escEnvironmentRevisions)
			.where(
				and(
					eq(escEnvironmentRevisions.environmentId, env.id),
					eq(escEnvironmentRevisions.revisionNumber, revisionNumber),
				),
			)
			.limit(1);
		return row ? toRevisionInfo(row) : null;
	}

	async openSession(
		_tenantId: string,
		_projectName: string,
		_envName: string,
	): Promise<OpenSessionResult> {
		void this.evaluator;
		void this.encryptionKeyHex;
		void this.sessionTtlSeconds;
		void escSessions;
		throw new Error("openSession not implemented — see procella-yj7.14");
	}

	async getSession(
		_tenantId: string,
		_projectName: string,
		_envName: string,
		_sessionId: string,
	): Promise<OpenSessionResult | null> {
		throw new Error("getSession not implemented — see procella-yj7.14");
	}
}

export type {
	EvaluateDiagnostic,
	EvaluatePayload,
	EvaluateResult,
	EvaluatorClient,
} from "./evaluator-client.js";
