// @procella/server — Hono route registration.

import { appRouter } from "@procella/api/src/router/index.js";
import type { TRPCContext } from "@procella/api/src/trpc.js";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import type { StacksService } from "@procella/stacks";
import { tracingMiddleware } from "@procella/telemetry";
import { PulumiRoutes } from "@procella/types";
import { GCWorker, type UpdatesService } from "@procella/updates";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	checkpointHandlers,
	cryptoHandlers,
	eventHandlers,
	healthHandlers,
	sseHandlers,
	stackHandlers,
	stateHandlers,
	updateHandlers,
	userHandlers,
} from "../handlers/index.js";
import {
	apiAuth,
	apiAuthWithQueryToken,
	decompress,
	errorHandler,
	pulumiAccept,
	requestLogger,
	updateAuth,
} from "../middleware/index.js";
import type { Env } from "../types.js";

// ============================================================================
// App Factory
// ============================================================================

export function createApp(deps: {
	auth: AuthService;
	authConfig: AuthConfig;
	corsOrigins?: string[];
	db: Database;
	stacks: StacksService;
	updates: UpdatesService;
}): Hono<Env> {
	const app = new Hono<Env>();

	// Global error handler (Hono onError hook)
	app.onError(errorHandler());

	// Global middleware
	app.use("*", tracingMiddleware());
	app.use("*", requestLogger());
	app.use("*", cors(deps.corsOrigins ? { origin: deps.corsOrigins } : undefined));
	app.use("*", decompress());

	// Create handler instances
	const health = healthHandlers({ db: deps.db });
	const user = userHandlers(deps.stacks);
	const stackH = stackHandlers(deps.stacks);
	const updateH = updateHandlers(deps.updates, deps.stacks);
	const checkpointH = checkpointHandlers(deps.updates);
	const eventH = eventHandlers(deps.updates);
	const cryptoH = cryptoHandlers(deps.updates);
	const stateH = stateHandlers(deps.updates, deps.stacks);
	const sseH = sseHandlers(deps.updates);

	// Middleware instances
	const withApiAuth = apiAuth(deps.auth);
	const withApiAuthWithQueryToken = apiAuthWithQueryToken(deps.auth);
	const withPulumiAccept = pulumiAccept();
	const withUpdateAuth = updateAuth(deps.auth);

	// ========================================================================
	// tRPC routes (/trpc/*)
	// ========================================================================

	app.all("/trpc/*", async (c) => {
		const caller = await deps.auth.authenticate(c.req.raw).catch(() => null);

		if (!caller) {
			return c.json({ code: 401, message: "Unauthorized" }, 401);
		}

		const ctx: TRPCContext = {
			caller,
			db: deps.db,
			stacks: deps.stacks,
			updates: deps.updates,
		};

		return fetchRequestHandler({
			endpoint: "/trpc",
			req: c.req.raw,
			router: appRouter,
			createContext: () => ctx,
		});
	});

	// ========================================================================
	// Public routes (no auth)
	// ========================================================================

	app.get("/healthz", health.health);
	app.get("/api/capabilities", health.capabilities);
	app.get("/api/cli/version", health.cliVersion);

	// Vercel Cron endpoint — GC worker runs as a scheduled job.
	// Registered outside /api/* to avoid pulumiAccept + apiAuth middleware.
	// Secured via Authorization: Bearer <CRON_SECRET> (set by Vercel automatically).
	app.get("/cron/gc", async (c) => {
		const secret = process.env.CRON_SECRET;
		const nodeEnv = process.env.NODE_ENV;

		if (!secret) {
			// Fail closed in non-development environments if the cron secret is missing.
			if (nodeEnv !== "development" && nodeEnv !== "test") {
				return c.json({ error: "Server misconfigured: CRON_SECRET is not set" }, 500);
			}
			// In development/test, allow running without auth to ease local testing.
		} else if (c.req.header("authorization") !== `Bearer ${secret}`) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const gc = new GCWorker({ db: deps.db });
		await gc.runOnce();
		return c.json({ ok: true });
	});

	// Auth config discovery — UI fetches this at runtime to determine auth mode.
	app.get("/api/auth/config", (c) => {
		if (deps.authConfig.mode === "descope") {
			return c.json({ mode: "descope" as const, projectId: deps.authConfig.projectId });
		}
		return c.json({ mode: "dev" as const });
	});

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

	// ========================================================================
	// Update-token authenticated routes (during active update execution)
	// These use "Authorization: update-token <lease-token>" from the CLI.
	// ========================================================================

	const R = PulumiRoutes;

	app.patch(R.patchCheckpoint.path, withUpdateAuth, checkpointH.patchCheckpoint);
	app.patch(R.patchCheckpointVerbatim.path, withUpdateAuth, checkpointH.patchCheckpointVerbatim);
	app.patch(R.patchCheckpointDelta.path, withUpdateAuth, checkpointH.patchCheckpointDelta);
	app.patch(R.patchJournalEntries.path, withUpdateAuth, checkpointH.appendJournalEntries);
	app.post(R.postEngineEventBatch.path, withUpdateAuth, eventH.postEvents);
	app.post(R.renewLease.path, withUpdateAuth, eventH.renewLease);
	app.post(R.completeUpdate.path, withUpdateAuth, updateH.completeUpdate);
	app.get("/api/updates/:updateId/stream", withApiAuthWithQueryToken, sseH.streamEvents);

	// ========================================================================
	// API-token authenticated routes
	// ========================================================================

	const api = new Hono<Env>();
	api.use("*", withApiAuth);
	api.use("*", withPulumiAccept);

	// User
	api.get("/user", user.getCurrentUser);
	api.get("/user/stacks", user.getUserStacks);
	api.get("/user/organizations/:orgName", user.getOrganization);

	// Stacks (specific routes first to avoid :kind catch-all)
	api.get("/stacks", stackH.listStacks);
	api.post("/stacks/:org/:project/:stack/rename", stackH.renameStack);
	api.patch("/stacks/:org/:project/:stack/tags", stackH.updateStackTags);

	// Update lifecycle (API token)
	api.post("/stacks/:org/:project/:stack/update/:updateId", updateH.startUpdate);
	api.post("/stacks/:org/:project/:stack/update/:updateId/cancel", updateH.cancelUpdate);
	api.get("/stacks/:org/:project/:stack/update/:updateId", updateH.getUpdate);
	api.get("/stacks/:org/:project/:stack/update/:updateId/events", eventH.getUpdateEvents);
	api.get("/stacks/:org/:project/:stack/updates", updateH.getHistory);

	// State operations (API token)
	api.get("/stacks/:org/:project/:stack/export", stateH.exportStack);
	api.get("/stacks/:org/:project/:stack/export/:version", stateH.exportStack);
	api.post("/stacks/:org/:project/:stack/import", stateH.importStack);

	// Crypto (API token)
	api.post("/stacks/:org/:project/:stack/encrypt", cryptoH.encryptValue);
	api.post("/stacks/:org/:project/:stack/decrypt", cryptoH.decryptValue);
	api.post("/stacks/:org/:project/:stack/batch-encrypt", cryptoH.batchEncrypt);
	api.post("/stacks/:org/:project/:stack/batch-decrypt", cryptoH.batchDecrypt);
	api.post("/stacks/:org/:project/:stack/log-decryption", cryptoH.logDecryption);

	// Stack CRUD + createUpdate (:kind catch-all LAST)
	api.post("/stacks/:org/:project/:stack/:kind", updateH.createUpdate);
	api.post("/stacks/:org/:project/:stack", stackH.createStack);
	api.get("/stacks/:org/:project/:stack", stackH.getStack);
	api.delete("/stacks/:org/:project/:stack", stackH.deleteStack);
	// 2-segment stack create: POST /api/stacks/:org/:project (stack name in body)
	api.post("/stacks/:org/:project", stackH.createStack);

	app.route("/api", api);
	return app;
}
