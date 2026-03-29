// @procella/server — CLI-only route factory for Pulumi CLI API.
//
// Mounts /api/* routes (stack CRUD, update lifecycle, checkpoints, crypto, state)
// with API-token and update-token auth. No tRPC, no CORS, no SSE.

import type { AuditService } from "@procella/audit";
import type { AuthConfig, AuthService } from "@procella/auth";
import type { Database } from "@procella/db";
import { type GitHubService, verifyGitHubWebhookSignature } from "@procella/github";
import type { StacksService } from "@procella/stacks";
import { tracingMiddleware } from "@procella/telemetry";
import { PulumiRoutes } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { WebhooksService } from "@procella/webhooks";
import { Hono } from "hono";
import {
	auditHandlers,
	checkpointHandlers,
	cryptoHandlers,
	eventHandlers,
	githubHandlers,
	healthHandlers,
	stackHandlers,
	stateHandlers,
	updateHandlers,
	userHandlers,
	webhookHandlers,
} from "../handlers/index.js";
import {
	apiAuth,
	auditMiddleware,
	decompress,
	errorHandler,
	pulumiAccept,
	requestLogger,
	requireRoleMiddleware,
	updateAuth,
} from "../middleware/index.js";
import type { Env } from "../types.js";

export interface CliAppDeps {
	auth: AuthService;
	authConfig: AuthConfig;
	audit: AuditService;
	db: Database;
	dbUrl: string;
	stacks: StacksService;
	updates: UpdatesService;
	webhooks: WebhooksService;
	github: GitHubService | null;
	githubWebhookSecret?: string;
}

export function createCliApp(deps: CliAppDeps): Hono<Env> {
	const app = new Hono<Env>();

	app.onError(errorHandler());

	// Global middleware — no CORS (CLI traffic only)
	app.use("*", tracingMiddleware());
	app.use("*", requestLogger());
	app.use("*", decompress());

	// Handler instances
	const health = healthHandlers({ db: deps.db });
	const user = userHandlers(deps.stacks);
	const stackH = stackHandlers(deps.stacks, deps.webhooks);
	const auditH = auditHandlers({ audit: deps.audit });
	const updateH = updateHandlers(deps.updates, deps.stacks, deps.webhooks, deps.github);
	const webhookH = webhookHandlers({ webhooks: deps.webhooks });
	const githubH = githubHandlers({
		github: deps.github,
		webhookSecret: deps.githubWebhookSecret,
		verifySignature: verifyGitHubWebhookSignature,
	});
	const checkpointH = checkpointHandlers(deps.updates);
	const eventH = eventHandlers(deps.updates);
	const cryptoH = cryptoHandlers(deps.updates);
	const stateH = stateHandlers(deps.updates, deps.stacks);

	// Middleware instances
	const withApiAuth = apiAuth(deps.auth);
	const withAudit = auditMiddleware(deps.audit);
	const withPulumiAccept = pulumiAccept();
	const withUpdateAuth = updateAuth(deps.auth, (updateId, token) =>
		deps.updates.verifyLeaseToken(updateId, token),
	);

	// Public routes
	app.get("/healthz", health.health);
	app.get("/api/capabilities", health.capabilities);
	app.get("/api/cli/version", health.cliVersion);

	// GitHub webhook (no auth — verified by signature)
	app.post("/api/webhooks/github", githubH.handleGitHubWebhook);

	// Update-token authenticated routes (during active update execution)
	const R = PulumiRoutes;
	app.patch(R.patchCheckpoint.path, withUpdateAuth, checkpointH.patchCheckpoint);
	app.patch(R.patchCheckpointVerbatim.path, withUpdateAuth, checkpointH.patchCheckpointVerbatim);
	app.patch(R.patchCheckpointDelta.path, withUpdateAuth, checkpointH.patchCheckpointDelta);
	app.patch(R.patchJournalEntries.path, withUpdateAuth, checkpointH.appendJournalEntries);
	app.post(R.postEngineEventBatch.path, withUpdateAuth, eventH.postEvents);
	app.post(R.renewLease.path, withUpdateAuth, eventH.renewLease);
	app.post(R.completeUpdate.path, withUpdateAuth, updateH.completeUpdate);

	// API-token authenticated routes
	const api = new Hono<Env>();
	api.use("*", withApiAuth);
	api.use("*", withAudit);
	api.use("*", withPulumiAccept);

	// User
	api.get("/user", user.getCurrentUser);
	api.get("/user/stacks", user.getUserStacks);
	api.get("/user/organizations/:orgName", user.getOrganization);
	api.get("/orgs/:org/auditlogs", requireRoleMiddleware("admin"), auditH.queryAuditLogs);
	api.get("/orgs/:org/auditlogs/export", requireRoleMiddleware("admin"), auditH.exportAuditLogs);
	api.post("/orgs/:org/hooks", requireRoleMiddleware("admin"), webhookH.createWebhook);
	api.get("/orgs/:org/hooks", requireRoleMiddleware("admin"), webhookH.listWebhooks);
	api.get("/orgs/:org/hooks/:hookId", requireRoleMiddleware("admin"), webhookH.getWebhook);
	api.put("/orgs/:org/hooks/:hookId", requireRoleMiddleware("admin"), webhookH.updateWebhook);
	api.delete("/orgs/:org/hooks/:hookId", requireRoleMiddleware("admin"), webhookH.deleteWebhook);
	api.get(
		"/orgs/:org/hooks/:hookId/deliveries",
		requireRoleMiddleware("admin"),
		webhookH.listDeliveries,
	);
	api.post("/orgs/:org/hooks/:hookId/ping", requireRoleMiddleware("admin"), webhookH.ping);
	api.get(
		"/orgs/:org/integrations/github",
		requireRoleMiddleware("admin"),
		githubH.getInstallation,
	);
	api.delete(
		"/orgs/:org/integrations/github",
		requireRoleMiddleware("admin"),
		githubH.removeInstallation,
	);

	// Stacks
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
	api.post("/stacks/:org/:project", stackH.createStack);

	app.route("/api", api);
	return app;
}
