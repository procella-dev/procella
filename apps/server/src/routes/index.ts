// @strata/server — Hono route registration.

import type { AuthService } from "@strata/auth";
import type { StacksService } from "@strata/stacks";
import type { UpdatesService } from "@strata/updates";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	checkpointHandlers,
	cryptoHandlers,
	eventHandlers,
	healthHandlers,
	stackHandlers,
	stateHandlers,
	updateHandlers,
	userHandlers,
} from "../handlers/index.js";
import {
	apiAuth,
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
	stacks: StacksService;
	updates: UpdatesService;
}): Hono<Env> {
	const app = new Hono<Env>();

	// Global error handler (Hono onError hook)
	app.onError(errorHandler());

	// Global middleware
	app.use("*", requestLogger());
	app.use("*", cors());

	// Create handler instances
	const health = healthHandlers();
	const user = userHandlers(deps.stacks);
	const stackH = stackHandlers(deps.stacks);
	const updateH = updateHandlers(deps.updates, deps.stacks);
	const checkpointH = checkpointHandlers(deps.updates);
	const eventH = eventHandlers(deps.updates);
	const cryptoH = cryptoHandlers(deps.updates);
	const stateH = stateHandlers(deps.updates, deps.stacks);

	// ========================================================================
	// Public routes (no auth)
	// ========================================================================

	app.get("/healthz", health.health);
	app.get("/api/capabilities", health.capabilities);
	app.get("/api/cli/version", health.cliVersion);

	// ========================================================================
	// API-token authenticated routes
	// ========================================================================

	const api = new Hono<Env>();
	api.use("*", apiAuth(deps.auth));
	api.use("*", pulumiAccept());

	// User
	api.get("/user", user.getCurrentUser);
	api.get("/user/stacks", user.getUserStacks);

	// Stacks (specific routes first to avoid :kind catch-all)
	api.get("/stacks", stackH.listStacks);
	api.post("/stacks/:org/:project/:stack/rename", stackH.renameStack);
	api.patch("/stacks/:org/:project/:stack/tags", stackH.updateStackTags);

	// Update lifecycle (API token)
	api.post("/stacks/:org/:project/:stack/update/:updateId", updateH.startUpdate);
	api.post("/stacks/:org/:project/:stack/update/:updateId/complete", updateH.completeUpdate);
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

	app.route("/api", api);

	// ========================================================================
	// Update-token authenticated routes (during active update execution)
	// ========================================================================

	const updateExec = new Hono<Env>();
	updateExec.use("*", updateAuth(deps.auth));

	updateExec.patch(
		"/stacks/:org/:project/:stack/update/:updateId/checkpoint",
		checkpointH.patchCheckpoint,
	);
	updateExec.patch(
		"/stacks/:org/:project/:stack/update/:updateId/checkpointverbatim",
		checkpointH.patchCheckpointVerbatim,
	);
	updateExec.post(
		"/stacks/:org/:project/:stack/update/:updateId/checkpoint/delta",
		checkpointH.patchCheckpointDelta,
	);
	updateExec.post("/stacks/:org/:project/:stack/update/:updateId/events/batch", eventH.postEvents);
	updateExec.post("/stacks/:org/:project/:stack/update/:updateId/renew_lease", eventH.renewLease);

	app.route("/api", updateExec);

	return app;
}
