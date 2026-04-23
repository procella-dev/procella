import { AesCryptoService } from "@procella/crypto";
import {
	type Database,
	escEnvironmentRevisions,
	escEnvironments,
	escProjects,
	escSessions,
} from "@procella/db";
import { withSpan } from "@procella/telemetry";
import { BadRequestError, ConflictError, NotFoundError, ProcellaError } from "@procella/types";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { EvaluateDiagnostic, EvaluatorClient } from "./evaluator-client.js";
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

	gcSweep(): Promise<{ closedCount: number }>;
}

export interface PostgresEscServiceDeps {
	db: Database;
	evaluator: EvaluatorClient;
	encryptionKeyHex: string;
	sessionTtlSeconds?: number;
}

// ============================================================================
// EscEvaluationError — 422 with evaluator diagnostics
// ============================================================================

export class EscEvaluationError extends ProcellaError {
	public readonly diagnostics: EvaluateDiagnostic[];

	constructor(diagnostics: EvaluateDiagnostic[]) {
		const summaries = diagnostics.map((d) => d.summary).join("; ");
		super(`Evaluation failed: ${summaries}`, "ESC_EVALUATION_ERROR", 422);
		this.name = "EscEvaluationError";
		this.diagnostics = diagnostics;
	}
}

// ============================================================================
// YAML import-list extraction (no npm yaml dep — evaluator does real parsing)
// ============================================================================

const MAX_IMPORT_DEPTH = 50;

/**
 * Extract `imports:` list from YAML body. Handles:
 * - `imports: [a, b, c]` (flow sequence)
 * - `imports:\n  - a\n  - b` (block sequence)
 * - Missing/empty imports → []
 * - Quoted/unquoted strings
 */
export function extractImports(yamlBody: string): string[] {
	const lines = yamlBody.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]?.match(/^[ \t]{0,256}imports:[ \t]{0,256}(.*)$/);
		if (!match) continue;

		const rest = match[1].trim();
		if (rest.startsWith("[")) {
			const closeIdx = rest.indexOf("]");
			if (closeIdx === -1) return [];
			const inner = rest.slice(1, closeIdx).trim();
			if (!inner) return [];

			const items: string[] = [];
			let current = "";
			let quote: '"' | "'" | null = null;
			for (const ch of inner) {
				if (quote) {
					if (ch === quote) quote = null;
					else current += ch;
					continue;
				}
				if (ch === '"' || ch === "'") {
					quote = ch;
					continue;
				}
				if (ch === ",") {
					const item = current.trim();
					if (item) items.push(item);
					current = "";
					continue;
				}
				current += ch;
			}
			const tail = current.trim();
			if (tail) items.push(tail);
			return items.map((s) => s.replace(/^["']|["']$/g, "")).filter(Boolean);
		}

		const items: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? "";
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;

			const dashIdx = trimmed.indexOf("-");
			if (dashIdx !== 0) break;
			const afterDash = trimmed.slice(1);
			if (afterDash.length === 0 || (afterDash[0] !== " " && afterDash[0] !== "\t")) break;

			let val = afterDash.trimStart();
			const hashIdx = val.indexOf("#");
			if (hashIdx > 0 && (val[hashIdx - 1] === " " || val[hashIdx - 1] === "\t")) {
				val = val.slice(0, hashIdx).trimEnd();
			}
			const value = val.replace(/^["']|["']$/g, "");
			if (value) items.push(value);
		}
		return items;
	}

	return [];
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

		return withSpan(
			"procella.esc",
			"esc.createEnvironment",
			{ "tenant.id": tenantId, "project.name": input.projectName, "env.name": input.name },
			async () => {
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
							.where(
								and(eq(escProjects.tenantId, tenantId), eq(escProjects.name, input.projectName)),
							);

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
						throw new ConflictError(
							`Environment ${input.projectName}/${input.name} already exists`,
						);
					}
					throw err;
				}
			},
		);
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

		return withSpan(
			"procella.esc",
			"esc.updateEnvironment",
			{ "tenant.id": tenantId, "project.name": projectName, "env.name": envName },
			() =>
				this.db.transaction(async (tx) => {
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
						.for("update", { of: escEnvironments });

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
				}),
		);
	}

	async deleteEnvironment(tenantId: string, projectName: string, envName: string): Promise<void> {
		return withSpan(
			"procella.esc",
			"esc.deleteEnvironment",
			{ "tenant.id": tenantId, "project.name": projectName, "env.name": envName },
			() =>
				this.db.transaction(async (tx) => {
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
				}),
		);
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
		tenantId: string,
		projectName: string,
		envName: string,
	): Promise<OpenSessionResult> {
		return withSpan(
			"procella.esc",
			"esc.openSession",
			{ "tenant.id": tenantId, "project.name": projectName, "env.name": envName },
			async () => {
				const envRow = await findEnvRow(this.db, tenantId, projectName, envName);
				if (!envRow) {
					throw new NotFoundError("Environment", `${projectName}/${envName}`);
				}

				const [revisionRow] = await this.db
					.select()
					.from(escEnvironmentRevisions)
					.where(
						and(
							eq(escEnvironmentRevisions.environmentId, envRow.id),
							eq(escEnvironmentRevisions.revisionNumber, envRow.currentRevisionNumber),
						),
					)
					.limit(1);
				if (!revisionRow) {
					throw new NotFoundError(
						"EnvironmentRevision",
						`${projectName}/${envName}#${envRow.currentRevisionNumber}`,
					);
				}

				const importRefs = extractImports(envRow.yamlBody);
				const resolvedImports = await withSpan(
					"procella.esc",
					"esc.resolveImports",
					{ "imports.count": importRefs.length, "imports.depth": 0 },
					async () =>
						this.resolveImports(
							this.db,
							tenantId,
							projectName,
							envRow.yamlBody,
							new Set<string>(),
							0,
						),
				);

				const result = await withSpan(
					"procella.esc",
					"esc.evaluator.invoke",
					{
						"env.name": envName,
						"imports.count": Object.keys(resolvedImports).length,
					},
					async () =>
						this.evaluator.evaluate({
							definition: envRow.yamlBody,
							imports: resolvedImports,
							encryptionKeyHex: this.encryptionKeyHex,
						}),
				);

				const errorDiags = result.diagnostics.filter((d) => d.severity === "error");
				if (errorDiags.length > 0) {
					throw new EscEvaluationError(errorDiags);
				}

				const [session] = await withSpan(
					"procella.esc",
					"esc.session.store",
					{ "secrets.count": result.secrets.length },
					async () => {
						const cryptoSvc = new AesCryptoService(this.encryptionKeyHex);
						const envFQN = `${tenantId}/${projectName}/${envName}`;
						const plaintext = new TextEncoder().encode(JSON.stringify(result.values));
						const cipherBytes = await cryptoSvc.encrypt(plaintext, envFQN);
						const ciphertextBase64 = Buffer.from(cipherBytes).toString("base64");

						const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);

						return this.db
							.insert(escSessions)
							.values({
								environmentId: envRow.id,
								revisionId: revisionRow.id,
								resolvedValuesCiphertext: ciphertextBase64,
								secretPaths: result.secrets,
								expiresAt,
							})
							.returning();
					},
				);

				return {
					sessionId: session.id,
					values: result.values,
					secrets: result.secrets,
					expiresAt: session.expiresAt,
				};
			},
		);
	}

	async getSession(
		tenantId: string,
		projectName: string,
		envName: string,
		sessionId: string,
	): Promise<OpenSessionResult | null> {
		return withSpan("procella.esc", "esc.getSession", { "session.id": sessionId }, async () => {
			const envRow = await findEnvRow(this.db, tenantId, projectName, envName);
			if (!envRow) {
				return null;
			}

			const [row] = await this.db
				.select()
				.from(escSessions)
				.where(
					and(
						eq(escSessions.id, sessionId),
						eq(escSessions.environmentId, envRow.id),
						isNull(escSessions.closedAt),
						gt(escSessions.expiresAt, new Date()),
					),
				)
				.limit(1);

			if (!row) {
				return null;
			}

			const cryptoSvc = new AesCryptoService(this.encryptionKeyHex);
			const envFQN = `${tenantId}/${projectName}/${envName}`;
			const cipherBytes = Buffer.from(row.resolvedValuesCiphertext, "base64");
			const plainBytes = await cryptoSvc.decrypt(new Uint8Array(cipherBytes), envFQN);
			const values = JSON.parse(new TextDecoder().decode(plainBytes)) as Record<string, unknown>;

			return {
				sessionId: row.id,
				values,
				secrets: row.secretPaths,
				expiresAt: row.expiresAt,
			};
		});
	}

	async gcSweep(): Promise<{ closedCount: number }> {
		return escGcSweep(this.db);
	}

	private async resolveImports(
		db: TxOrDb,
		tenantId: string,
		contextProjectName: string,
		yamlBody: string,
		visited: Set<string>,
		depth: number,
	): Promise<Record<string, string>> {
		if (depth > MAX_IMPORT_DEPTH) {
			throw new BadRequestError(
				`import_too_deep: exceeded maximum import depth of ${MAX_IMPORT_DEPTH}`,
			);
		}

		const importRefs = extractImports(yamlBody);
		if (importRefs.length === 0) return {};

		const result: Record<string, string> = {};

		await Promise.all(
			importRefs.map(async (ref) => {
				let importProject: string;
				let importEnv: string;
				if (ref.includes("/")) {
					const slashIdx = ref.indexOf("/");
					importProject = ref.slice(0, slashIdx);
					importEnv = ref.slice(slashIdx + 1);
				} else {
					importProject = contextProjectName;
					importEnv = ref;
				}

				const fqn = `${importProject}/${importEnv}`;
				if (visited.has(fqn)) {
					throw new BadRequestError(
						`import_cycle: circular import detected: ${[...visited, fqn].join(" → ")}`,
					);
				}

				const importedRow = await findEnvRow(db, tenantId, importProject, importEnv);
				if (!importedRow) {
					throw new NotFoundError("ImportedEnvironment", fqn);
				}

				const childVisited = new Set(visited);
				childVisited.add(fqn);

				const childImports = await this.resolveImports(
					db,
					tenantId,
					importProject,
					importedRow.yamlBody,
					childVisited,
					depth + 1,
				);

				Object.assign(result, childImports);
				result[fqn] = importedRow.yamlBody;
			}),
		);

		return result;
	}
}

// ============================================================================
// ESC Session GC — standalone function for use by cron lambdas
// ============================================================================

/** Advisory lock ID for ESC session GC (ASCII "ESCG_ESC"). Distinct from updates GC lock. */
const ESC_GC_ADVISORY_LOCK_ID: bigint = BigInt("0x455343475f455343");

/**
 * Sweep expired ESC sessions. Uses pg_try_advisory_lock for cluster safety.
 * Soft-closes (sets closed_at) up to 1000 expired sessions per sweep.
 * Returns { closedCount: 0 } if lock not acquired (another replica handles it).
 */
export async function escGcSweep(db: Database): Promise<{ closedCount: number }> {
	const lockId = ESC_GC_ADVISORY_LOCK_ID.toString();
	return withSpan("procella.esc", "esc.gc.sweep", {}, async () => {
		return await db.transaction(async (tx) => {
			const lockResult = await tx.execute(
				sql`SELECT pg_try_advisory_xact_lock(${lockId}::bigint) as acquired`,
			);
			const rows = "rows" in lockResult ? lockResult.rows : lockResult;
			const acquired = (rows[0] as { acquired?: boolean })?.acquired;
			if (!acquired) {
				return { closedCount: 0 };
			}

			const expired = await tx
				.select({ id: escSessions.id })
				.from(escSessions)
				.where(and(lt(escSessions.expiresAt, sql`now()`), isNull(escSessions.closedAt)))
				.limit(1000);

			if (expired.length === 0) {
				return { closedCount: 0 };
			}

			const ids = expired.map((s) => s.id);
			await tx
				.update(escSessions)
				.set({ closedAt: sql`now()` })
				.where(inArray(escSessions.id, ids));

			return { closedCount: ids.length };
		});
	});
}

export type {
	EvaluateDiagnostic,
	EvaluatePayload,
	EvaluateResult,
	EvaluatorClient,
} from "./evaluator-client.js";
