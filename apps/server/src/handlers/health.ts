// @strata/server — Health and capabilities handlers.

import type { CapabilitiesResponse, CLIVersionResponse } from "@strata/types";
import type { Context } from "hono";
import type { Env } from "../types.js";

// ============================================================================
// Health Handlers
// ============================================================================

export function healthHandlers() {
	return {
		health: (c: Context<Env>) => c.json({ status: "ok" }, 200),

		capabilities: (c: Context<Env>) =>
			c.json({
				capabilities: [
					{
						capability: "delta-checkpoint-uploads-v2",
						version: 2,
						configuration: { checkpointCutoffSizeBytes: 1_048_576 },
					},
					{ capability: "batch-encrypt" },
					{ capability: "deployment-schema-version", version: 3 },
				],
			} satisfies CapabilitiesResponse),

		cliVersion: (c: Context<Env>) =>
			c.json({
				latestVersion: "3.0.0",
				oldestWithoutWarning: "3.0.0",
				latestDevVersion: "3.0.0",
			} satisfies CLIVersionResponse),
	};
}
