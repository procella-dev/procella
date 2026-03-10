// @procella/server — Hono environment type definitions.

import type { Caller } from "@procella/types";

// ============================================================================
// Hono Env
// ============================================================================

export type Env = {
	Variables: {
		caller: Caller;
		updateContext?: { updateId: string; stackId: string };
	};
};
