// @procella/server — Checkpoint patch handlers.

import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { updateContext } from "./params.js";

// ============================================================================
// Checkpoint Handlers
// ============================================================================

export function checkpointHandlers(updates: UpdatesService) {
	return {
		patchCheckpoint: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.json();
			await updates.patchCheckpoint(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		patchCheckpointVerbatim: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.json();
			await updates.patchCheckpointVerbatim(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		patchCheckpointDelta: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.json();
			await updates.patchCheckpointDelta(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		appendJournalEntries: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const body = await c.req.json();
			await updates.appendJournalEntries(updateCtx.updateId, body);
			return c.body(null, 200);
		},
	};
}
