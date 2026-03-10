// @procella/api — Root tRPC AppRouter definition.

import { router } from "../trpc.js";
import { eventsRouter } from "./events.js";
import { stacksRouter } from "./stacks.js";
import { updatesRouter } from "./updates.js";

// ============================================================================
// App Router
// ============================================================================

export const appRouter = router({
	stacks: stacksRouter,
	updates: updatesRouter,
	events: eventsRouter,
});

export type AppRouter = typeof appRouter;
