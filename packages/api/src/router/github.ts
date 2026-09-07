import { createGitHubSetupNonce, GitHubSetupError } from "@procella/github";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { adminProcedure, protectedProcedure, router } from "../trpc.js";

const SETUP_ERROR_MESSAGES: Record<string, { code: TRPCError["code"]; message: string }> = {
	authorization_unavailable: {
		code: "PRECONDITION_FAILED",
		message: "GitHub user verification is not configured on this server",
	},
	authorization_required: {
		code: "FORBIDDEN",
		message:
			"Connect a GitHub account that owns this account or administers this organization, then retry",
	},
	authorization_failed: {
		code: "BAD_GATEWAY",
		message: "GitHub could not confirm your account administration",
	},
};

function trpcSetupError(error: unknown): TRPCError {
	if (error instanceof GitHubSetupError) {
		const mapped = SETUP_ERROR_MESSAGES[error.code];
		if (mapped) return new TRPCError(mapped);
		return new TRPCError({ code: "BAD_REQUEST", message: error.code });
	}
	return new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Unable to start GitHub setup",
	});
}

export const githubRouter = router({
	status: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.github) {
			return {
				configured: false as const,
				connectAvailable: false,
				connectedLogin: null,
				installations: [],
			};
		}
		const connectAvailable = ctx.github.connectAvailable && Boolean(ctx.startGitHubConnect);
		return {
			configured: true as const,
			connectAvailable,
			// Reported for the caller's own session only, and only the login; the
			// vaulted GitHub token never leaves the server.
			connectedLogin: connectAvailable
				? await ctx.github.resolveConnectedLogin(ctx.caller.userId)
				: null,
			installations: await ctx.github.listInstallations(ctx.caller.tenantId),
		};
	}),

	/**
	 * Cookie-mode safe outbound handoff: the server exchanges the request's own
	 * Descope session for the GitHub authorization URL, so no session, refresh,
	 * or GitHub token is ever exposed to the browser.
	 */
	startConnect: adminProcedure.mutation(async ({ ctx }) => {
		if (!ctx.github) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "GitHub App is not configured on this server",
			});
		}
		if (!ctx.github.connectAvailable || !ctx.startGitHubConnect) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "GitHub user verification is not configured on this server",
			});
		}
		return { url: await ctx.startGitHubConnect() };
	}),

	createInstallationUrl: adminProcedure
		.input(
			z.object({
				accountLogin: z
					.string()
					.trim()
					.min(1)
					.max(100)
					.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.github) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "GitHub App is not configured on this server",
				});
			}
			if (!ctx.setGitHubSetupCookie) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "GitHub setup cookie support is unavailable",
				});
			}

			const browserNonce = createGitHubSetupNonce();
			let url: string;
			try {
				url = await ctx.github.issueInstallationUrl(
					ctx.caller.tenantId,
					input.accountLogin,
					ctx.caller.userId,
					browserNonce,
				);
			} catch (error) {
				throw trpcSetupError(error);
			}
			ctx.setGitHubSetupCookie(browserNonce);
			return { url };
		}),

	removeInstallation: adminProcedure
		.input(z.object({ installationId: z.number().int().positive() }))
		.mutation(async ({ ctx, input }) => {
			if (ctx.github) {
				try {
					await ctx.github.removeInstallation(
						ctx.caller.tenantId,
						input.installationId,
						ctx.caller.userId,
					);
				} catch (error) {
					throw trpcSetupError(error);
				}
			}
			return { success: true };
		}),
});
