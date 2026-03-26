import type { GitHubService } from "@procella/github";
import { BadRequestError } from "@procella/types";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

export function githubHandlers(deps: {
	github: GitHubService | null;
	webhookSecret?: string;
	verifySignature: (payload: string, signature: string, secret: string) => Promise<boolean>;
}) {
	return {
		handleGitHubWebhook: async (c: Context<Env>) => {
			const payload = await c.req.text();
			const signature = c.req.header("X-Hub-Signature-256") ?? "";
			const event = c.req.header("X-GitHub-Event") ?? "";

			if (!deps.github || !deps.webhookSecret) {
				return c.body(null, 200);
			}

			if (!event) {
				throw new BadRequestError("Missing X-GitHub-Event header");
			}

			const valid = await deps.verifySignature(payload, signature, deps.webhookSecret);
			if (!valid) {
				return c.json({ error: "Invalid webhook signature" }, 401);
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(payload) as unknown;
			} catch {
				throw new BadRequestError("Invalid JSON payload");
			}
			await deps.github.handleWebhookEvent(event, parsed);
			return c.body(null, 200);
		},

		getInstallation: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			if (!deps.github) {
				return c.json({ installation: null });
			}

			const installation = await deps.github.getInstallation(caller.tenantId);
			return c.json({ installation });
		},

		removeInstallation: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const org = param(c, "org");
			if (org !== caller.orgSlug) {
				throw new BadRequestError("Organization does not match caller organization");
			}

			if (!deps.github) {
				return c.body(null, 204);
			}

			const installation = await deps.github.getInstallation(caller.tenantId);
			if (installation) {
				await deps.github.removeInstallation(installation.installationId);
			}

			return c.body(null, 204);
		},
	};
}
