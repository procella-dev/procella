// @procella/server — Web-only route factory for dashboard tRPC API + SSE.
//
// Mounts /trpc/* (queries, mutations, SSE subscriptions) and /api/auth/*
// (auth config discovery, CLI token creation). No Pulumi CLI routes.
// Served from the same origin as the UI — no CORS needed.

import { appRouter } from "@procella/api/src/router/index.js";
import type { TRPCContext } from "@procella/api/src/trpc.js";
import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { GitHubService } from "@procella/github";
import type { OidcService } from "@procella/oidc";
import type { StacksService } from "@procella/stacks";
import { tracingMiddleware } from "@procella/telemetry";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { healthHandlers, oauthHandlers } from "../handlers/index.js";
import { decompress, errorHandler, requestLogger } from "../middleware/index.js";
import type { Env } from "../types.js";

export interface WebAppDeps {
	auth: AuthService;
	authConfig: AuthConfig;
	audit: AuditService;
	db: Database;
	dbUrl: string;
	stacks: StacksService;
	updates: UpdatesService;
	webhooks: WebhooksService;
	github: GitHubService | null;
	oidc?: OidcService | null;
}

export function createWebApp(deps: WebAppDeps): Hono<Env> {
	const app = new Hono<Env>();

	app.onError(errorHandler());

	// Global middleware — no CORS (same origin as UI)
	app.use("*", tracingMiddleware());
	app.use("*", requestLogger());
	app.use("*", decompress());

	// Health check
	const health = healthHandlers({ db: deps.db });
	app.get("/healthz", health.health);

	// Auth config discovery — UI fetches this to determine auth mode
	app.get("/api/auth/config", (c) => {
		if (deps.authConfig.mode === "descope") {
			return c.json({ mode: "descope" as const, projectId: deps.authConfig.projectId });
		}
		return c.json({ mode: "dev" as const });
	});

	// CLI token creation — browser login flow
	app.post("/api/auth/cli-token", async (c) => {
		if (!deps.auth.createCliAccessKey) {
			return c.json({ error: "CLI token creation not available in this auth mode" }, 400);
		}
		const caller = await deps.auth.authenticate(c.req.raw).catch(() => null);
		if (!caller) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const body = await c.req.json<{ name?: string }>().catch(() => ({}));
		const keyName =
			"name" in body && body.name ? body.name : `procella-cli-${caller.login}-${Date.now()}`;
		const cleartext = await deps.auth.createCliAccessKey(caller, keyName);
		return c.json({ token: cleartext });
	});

	const oauth = oauthHandlers(deps.oidc ?? null);
	app.post("/api/oauth/token", oauth.tokenExchange);

	// tRPC routes — queries, mutations, SSE subscriptions
	app.all("/trpc/*", async (c) => {
		let req = c.req.raw;

		// SSE subscriptions pass auth via connectionParams (EventSource can't set headers)
		const cpRaw = c.req.query("connectionParams");
		if (cpRaw && req.method === "GET" && !req.headers.get("Authorization")) {
			try {
				const cp = JSON.parse(decodeURIComponent(cpRaw)) as Record<string, string>;
				if (cp.authorization) {
					const headers = new Headers(req.headers);
					headers.set("Authorization", cp.authorization);
					req = new Request(req, { headers });
				}
			} catch {}
		}

		const caller = await deps.auth.authenticate(req).catch(() => null);

		if (!caller) {
			return c.json({ code: 401, message: "Unauthorized" }, 401);
		}

		const ctx: TRPCContext = {
			caller,
			db: deps.db,
			dbUrl: deps.dbUrl,
			stacks: deps.stacks,
			audit: deps.audit,
			updates: deps.updates,
			webhooks: deps.webhooks,
			github: deps.github,
		};

		return fetchRequestHandler({
			endpoint: "/trpc",
			req,
			router: appRouter,
			createContext: () => ctx,
			onError({ error }) {
				if (error.code !== "UNAUTHORIZED") {
					console.error("[trpc]", error);
				}
			},
		});
	});

	return app;
}
