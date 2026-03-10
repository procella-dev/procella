// @procella/api — tRPC initialization and context definition.

import type { Database } from "@procella/db";
import type { StacksService } from "@procella/stacks";
import type { Caller } from "@procella/types";
import type { UpdatesService } from "@procella/updates";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";

// ============================================================================
// Context
// ============================================================================

export interface TRPCContext {
	caller: Caller;
	db: Database;
	stacks: StacksService;
	updates: UpdatesService;
}

// ============================================================================
// tRPC Instance
// ============================================================================

const t = initTRPC.context<TRPCContext>().create({
	transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
