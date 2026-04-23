import type { CreateEnvironmentInput, EscService, UpdateEnvironmentInput } from "@procella/esc";
import { BadRequestError, NotFoundError } from "@procella/types";
import type { Context } from "hono";
import { z } from "zod/v4";
import type { Env } from "../types.js";
import { param } from "./params.js";

const yamlBodySchema = z.object({ yamlBody: z.string() });

export function escHandlers(deps: { esc: EscService }) {
	const requireOrgMatch = (c: Context<Env>): string => {
		const caller = c.get("caller");
		const org = param(c, "org");
		if (org !== caller.orgSlug) {
			throw new BadRequestError("Organization does not match caller organization");
		}
		return caller.tenantId;
	};

	return {
		createEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const body = await c.req.json().catch(() => ({}));
			const schema = z.object({ name: z.string().min(1), yamlBody: z.string() });
			const parsed = schema.parse(body);
			const input: CreateEnvironmentInput = {
				projectName,
				name: parsed.name,
				yamlBody: parsed.yamlBody,
			};
			const env = await deps.esc.createEnvironment(tenantId, input, caller.userId);
			return c.json(env, 201);
		},

		listEnvironments: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envs = await deps.esc.listEnvironments(tenantId, projectName);
			return c.json({ environments: envs });
		},

		getEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const env = await deps.esc.getEnvironment(tenantId, projectName, envName);
			if (!env) {
				throw new NotFoundError("Environment", `${projectName}/${envName}`);
			}
			return c.json(env);
		},

		updateEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const caller = c.get("caller");
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const body = await c.req.json().catch(() => ({}));
			const parsed = yamlBodySchema.parse(body);
			const input: UpdateEnvironmentInput = { yamlBody: parsed.yamlBody };
			const env = await deps.esc.updateEnvironment(
				tenantId,
				projectName,
				envName,
				input,
				caller.userId,
			);
			return c.json(env);
		},

		deleteEnvironment: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			await deps.esc.deleteEnvironment(tenantId, projectName, envName);
			return c.body(null, 204);
		},

		listRevisions: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const revisions = await deps.esc.listRevisions(tenantId, projectName, envName);
			return c.json({ revisions });
		},

		getRevision: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const versionStr = param(c, "version");
			const revisionNumber = Number.parseInt(versionStr, 10);
			if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
				throw new BadRequestError("version must be a positive integer");
			}
			const rev = await deps.esc.getRevision(tenantId, projectName, envName, revisionNumber);
			if (!rev) {
				throw new NotFoundError("EnvironmentRevision", `${projectName}/${envName}#${versionStr}`);
			}
			return c.json(rev);
		},

		openSession: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const result = await deps.esc.openSession(tenantId, projectName, envName);
			return c.json(result, 201);
		},

		getSession: async (c: Context<Env>) => {
			const tenantId = requireOrgMatch(c);
			const projectName = param(c, "project");
			const envName = param(c, "envName");
			const sessionId = param(c, "sessionId");
			const result = await deps.esc.getSession(tenantId, projectName, envName, sessionId);
			if (!result) {
				throw new NotFoundError("EscSession", sessionId);
			}
			return c.json(result);
		},
	};
}
