// @procella/server — User endpoint handlers.

import type { StacksService } from "@procella/stacks";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

// ============================================================================
// User Handlers
// ============================================================================

export function userHandlers(stacks: StacksService) {
	return {
		getCurrentUser: (c: Context<Env>) => {
			const caller = c.get("caller");
			return c.json({
				githubLogin: caller.login,
				name: caller.login,
				organizations: [
					{
						githubLogin: caller.orgSlug,
						name: caller.orgSlug,
					},
				],
			});
		},

		getUserStacks: async (c: Context<Env>) => {
			const caller = c.get("caller");
			const stacksList = await stacks.listStacks(caller.tenantId);
			const mapped = stacksList.map((s) => ({
				...s,
				orgName: caller.orgSlug,
			}));
			return c.json({ stacks: mapped });
		},

		/**
		 * GET /api/user/organizations/:orgName — Pulumi CLI fetches org details.
		 * When orgName is "default", returns the caller's default org (used by the
		 * CLI to resolve stack names that omit the org prefix).
		 *
		 * M5 fix: Always use caller.orgSlug as the authoritative org identity.
		 * If URL orgName doesn't match caller.orgSlug, return 404 (uniform pattern,
		 * not 403, per Pulumi protocol) to prevent UI spoofing via URL manipulation.
		 */
		getOrganization: (c: Context<Env>) => {
			const orgName = param(c, "orgName");
			const caller = c.get("caller");
			if (orgName === "default") {
				return c.json({ githubLogin: caller.orgSlug });
			}
			// Reject if URL orgName doesn't match caller's org — uniform 404.
			if (orgName !== caller.orgSlug) {
				return c.json({ code: 404, message: "not found" }, 404);
			}
			return c.json({
				githubLogin: caller.orgSlug,
				name: caller.orgSlug,
				defaultTeam: { type: "pulumi", name: caller.orgSlug },
			});
		},
	};
}
