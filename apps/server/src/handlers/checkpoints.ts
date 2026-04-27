// @procella/server — Checkpoint patch handlers.

import type {
	JournalEntries,
	PatchUpdateCheckpointDeltaRequest,
	PatchUpdateCheckpointRequest,
	PatchUpdateVerbatimCheckpointRequest,
} from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { updateContext } from "./params.js";
import {
	JournalEntriesSchema,
	PatchUpdateCheckpointDeltaRequestSchema,
	PatchUpdateCheckpointRequestSchema,
	PatchUpdateVerbatimCheckpointRequestSchema,
} from "./schemas.js";

// ============================================================================
// Checkpoint Handlers
// ============================================================================

export function checkpointHandlers(updates: UpdatesService) {
	return {
		patchCheckpoint: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (_err) {
				return c.json({ code: "invalid_request", message: "Body is not valid JSON" }, 400);
			}
			const parseResult = PatchUpdateCheckpointRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const body = parseResult.data as PatchUpdateCheckpointRequest;
			await updates.patchCheckpoint(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		patchCheckpointVerbatim: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (_err) {
				return c.json({ code: "invalid_request", message: "Body is not valid JSON" }, 400);
			}
			const parseResult = PatchUpdateVerbatimCheckpointRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const body = parseResult.data as PatchUpdateVerbatimCheckpointRequest;
			await updates.patchCheckpointVerbatim(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		patchCheckpointDelta: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const raw = await c.req.json();
			const parseResult = PatchUpdateCheckpointDeltaRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const body = parseResult.data as PatchUpdateCheckpointDeltaRequest;
			await updates.patchCheckpointDelta(updateCtx.updateId, body);
			return c.body(null, 200);
		},

		appendJournalEntries: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			const raw = await c.req.json();
			const parseResult = JournalEntriesSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			const body: JournalEntries = {
				entries: parseResult.data.entries as JournalEntries["entries"],
			};
			await updates.appendJournalEntries(updateCtx.updateId, body);
			return c.body(null, 200);
		},
	};
}
