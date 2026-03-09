// @strata/api — tRPC initialization and context definition.

import type { Database } from "@strata/db";
import type { StacksService } from "@strata/stacks";
import type { Caller } from "@strata/types";
import type { UpdatesService } from "@strata/updates";
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
