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

const INVALID_JSON_RESPONSE = {
	code: "invalid_request",
	message: "Body is not valid JSON",
} as const;

export function checkpointHandlers(updates: UpdatesService) {
	return {
		patchCheckpoint: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = PatchUpdateCheckpointRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			await updates.patchCheckpoint(
				updateCtx.updateId,
				parseResult.data as PatchUpdateCheckpointRequest,
			);
			return c.body(null, 200);
		},

		patchCheckpointVerbatim: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = PatchUpdateVerbatimCheckpointRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			await updates.patchCheckpointVerbatim(
				updateCtx.updateId,
				parseResult.data as PatchUpdateVerbatimCheckpointRequest,
			);
			return c.body(null, 200);
		},

		patchCheckpointDelta: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
			const parseResult = PatchUpdateCheckpointDeltaRequestSchema.safeParse(raw);
			if (!parseResult.success) {
				return c.json({ code: "invalid_request", message: parseResult.error.message }, 400);
			}
			await updates.patchCheckpointDelta(
				updateCtx.updateId,
				parseResult.data as PatchUpdateCheckpointDeltaRequest,
			);
			return c.body(null, 200);
		},

		appendJournalEntries: async (c: Context<Env>) => {
			const updateCtx = updateContext(c);
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json(INVALID_JSON_RESPONSE, 400);
			}
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
