import {
	GITHUB_SETUP_COOKIE_NAME,
	GITHUB_SETUP_STATE_TTL_SECONDS,
	type GitHubService,
	GitHubSetupError,
} from "@procella/github";
import { BadRequestError } from "@procella/types";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../types.js";
import { param } from "./params.js";

const MAX_GITHUB_WEBHOOK_BYTES = 25 * 1024 * 1024;

class GitHubWebhookTooLargeError extends Error {}

async function readGitHubWebhookBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
	if (!body) return new Uint8Array();

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	let finished = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				break;
			}
			bytesRead += value.byteLength;
			if (bytesRead > MAX_GITHUB_WEBHOOK_BYTES) {
				throw new GitHubWebhookTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		if (!finished) {
			await reader.cancel().catch(() => undefined);
		}
		reader.releaseLock();
	}

	return Buffer.concat(chunks, bytesRead);
}

/**
 * `__Host-` requires Secure, Path=/, and no Domain, so browsers reject the cookie on plaintext
 * origins and refuse sibling-subdomain shadowing regardless of the scheme this process observes
 * behind a TLS-terminating proxy.
 */
export function githubSetupCookieHeader(
	name: string,
	value: string,
	maxAge = GITHUB_SETUP_STATE_TTL_SECONDS,
): string {
	return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function githubHandlers(deps: {
	github: GitHubService | null;
	webhookSecret?: string;
	verifySignature: (payload: Uint8Array, signature: string, secret: string) => Promise<boolean>;
}) {
	return {
		handleGitHubWebhook: async (c: Context<Env>) => {
			if (!deps.github || !deps.webhookSecret) {
				return c.body(null, 200);
			}

			const signature = c.req.header("X-Hub-Signature-256");
			if (!signature || !/^sha256=[0-9a-fA-F]{64}$/.test(signature)) {
				return c.json({ error: "Invalid webhook signature" }, 401);
			}

			const event = c.req.header("X-GitHub-Event");
			if (!event) {
				throw new BadRequestError("Missing X-GitHub-Event header");
			}

			const contentLength = Number(c.req.header("Content-Length"));
			if (Number.isFinite(contentLength) && contentLength > MAX_GITHUB_WEBHOOK_BYTES) {
				return c.json({ error: "Webhook payload too large" }, 413);
			}

			let payload: Uint8Array;
			try {
				payload = await readGitHubWebhookBody(c.req.raw.body);
			} catch (error) {
				if (error instanceof GitHubWebhookTooLargeError) {
					return c.json({ error: "Webhook payload too large" }, 413);
				}
				throw error;
			}
			const valid = await deps.verifySignature(payload, signature, deps.webhookSecret);
			if (!valid) {
				return c.json({ error: "Invalid webhook signature" }, 401);
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
			} catch {
				throw new BadRequestError("Invalid JSON payload");
			}
			await deps.github.handleWebhookEvent(event, parsed);
			return c.body(null, 200);
		},
		/**
		 * GitHub's setup callback. `setup_action=update` arrives when the App is
		 * already installed on the account and the admin re-runs the flow, so both
		 * actions bind the installation; the signed browser-bound state, the
		 * App-authenticated installation data, and the vaulted GitHub identity are
		 * what authorize it, not the action string.
		 */
		completeInstallation: async (c: Context<Env>) => {
			c.header("Cache-Control", "no-store");
			if (!deps.github) {
				return redirectToGitHubSettings(c, "not_configured");
			}

			const state = c.req.query("state");
			const installationIdValue = c.req.query("installation_id");
			const setupAction = c.req.query("setup_action");
			if (setupAction && setupAction !== "install" && setupAction !== "update") {
				return redirectToGitHubSettings(c, "unsupported_setup_action");
			}
			if (
				!state ||
				state.length > 4096 ||
				!installationIdValue ||
				!/^[1-9]\d*$/.test(installationIdValue) ||
				!setupAction
			) {
				return redirectToGitHubSettings(c, "invalid_callback");
			}

			const installationId = Number(installationIdValue);
			if (!Number.isSafeInteger(installationId)) {
				return redirectToGitHubSettings(c, "invalid_callback");
			}

			const browserNonce = getCookie(c, GITHUB_SETUP_COOKIE_NAME);
			if (!browserNonce) return redirectToGitHubSettings(c, "invalid_state");

			try {
				await deps.github.completeInstallation(state, installationId, browserNonce);
				c.header("Set-Cookie", githubSetupCookieHeader(GITHUB_SETUP_COOKIE_NAME, "", 0));
				return c.redirect("/settings?github=connected#github", 303);
			} catch (error) {
				const reason = error instanceof GitHubSetupError ? error.code : "github_error";
				return redirectToGitHubSettings(c, reason);
			}
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

			const installations = await deps.github.listInstallations(caller.tenantId);
			return c.json({ installation: installations[0] ?? null });
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

			const installations = await deps.github.listInstallations(caller.tenantId);
			for (const installation of installations) {
				await deps.github.removeInstallation(
					caller.tenantId,
					installation.installationId,
					caller.userId,
				);
			}

			return c.body(null, 204);
		},
	};
}

function redirectToGitHubSettings(c: Context<Env>, reason: string) {
	return c.redirect(`/settings?github=error&reason=${encodeURIComponent(reason)}#github`, 303);
}
